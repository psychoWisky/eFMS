// Signing with the officer's DSC (USB token) through Capricorn's "Browser
// Signing Solution" — a small application on the officer's own PC that listens
// on http://127.0.0.1:1620. eFMS sends it the SHA-256 digest of the prepared
// PDF (command pkiNetworkSignHash); the officer enters the token PIN; it
// returns a Base64 PKCS#7 signature. The private key never leaves the token
// and the document never leaves the server.

/** Address of the signing application (change if the PC's service uses another port). */
export const DSC_URL = process.env.NEXT_PUBLIC_DSC_URL ?? "http://127.0.0.1:1620";

/** Time allowed for the officer to pick the certificate and type the PIN. */
const SIGN_TIMEOUT_MS = 3 * 60 * 1000;

export class DscClientError extends Error {}

interface SignHashResponse {
  response?: { status?: string; data?: string; message?: string; error?: string; errormessage?: string; description?: string };
}

/** Ask the signing application to sign `hashHex` (64 hex characters) with the
 * token. Resolves with the Base64 PKCS#7 signature. */
export async function signHashOnToken(hashHex: string, txn: string): Promise<string> {
  // The signing application Base64-decodes `data` and signs those bytes as the
  // digest, so the hash must be sent as Base64 of the raw 32 bytes (sending the
  // hex text makes it sign a different, 48-byte value — found from the live log).
  const hashBytes = hashHex.match(/../g)!.map((h) => parseInt(h, 16));
  const hashB64 = btoa(String.fromCharCode(...hashBytes));
  const body = JSON.stringify({
    request: {
      command: "pkiNetworkSignHash",
      ts: new Date().toISOString(),
      txn,
      certificate: { attribute: ["AP=1", "CN=", "SN=", "TC=SG"] },
      file: { attribute: ["type=pdf"] },
      data: hashB64,
    },
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SIGN_TIMEOUT_MS);
  let text: string;
  try {
    // text/plain keeps this a "simple" request, so no CORS pre-flight is needed.
    const res = await fetch(DSC_URL, { method: "POST", body, headers: { "Content-Type": "text/plain" }, signal: ctrl.signal });
    text = await res.text();
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      throw new DscClientError("Signing timed out. Please try again and enter your PIN promptly.");
    }
    throw new DscClientError(
      "Could not reach the DSC signing application on this computer. Make sure “Browser Signing Solution” is running " +
      "(system tray), your USB token is plugged in and registered, then try again.",
    );
  } finally {
    clearTimeout(timer);
  }

  let json: SignHashResponse;
  try {
    json = JSON.parse(text) as SignHashResponse;
  } catch {
    throw new DscClientError("The DSC signing application returned an unexpected reply.");
  }
  const r = json.response;
  if (!r || String(r.status ?? "").toLowerCase() !== "ok" || !r.data) {
    const why = r?.message ?? r?.errormessage ?? r?.error ?? r?.description ?? r?.status ?? "no details";
    throw new DscClientError(`The DSC signing application did not sign: ${why}.`);
  }
  return r.data;
}
