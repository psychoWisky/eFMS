"use client";
// Client-side .docx renderer shared by the eSign document canvas
// (components/signature/pdf-signature-canvas.tsx) and the general Attachment
// Preview modal — extracted from pdf-signature-canvas.tsx so both consumers
// use one implementation instead of two. Fetches the file as a Blob and lets
// the docx-preview package convert it to HTML in-place; no server-side
// rendering, no PDF conversion.
//
// Fetches via the shared `api` axios client (not raw `fetch`) so the
// Authorization header is attached automatically — the attachment
// view/preview-docx endpoints now require authentication. Works for both
// relative backend paths and the absolute URLs the eSign canvas already
// passes (a plain static-file URL for native .docx, or an API_URL-prefixed
// preview-docx URL for legacy .doc) — axios uses an absolute `url` as-is,
// ignoring baseURL, while the request interceptor still attaches the token
// either way.
import { useEffect, useRef, useState } from "react";
import { Loader2, AlertCircle } from "lucide-react";
import { api } from "@/services/api";

interface Props {
  fileUrl: string;
}

export default function DocxViewer({ fileUrl }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    container.innerHTML = "";

    (async () => {
      try {
        const res = await api.get(fileUrl, { responseType: "blob" });
        const blob = res.data as Blob;
        if (cancelled) return;
        const { renderAsync } = await import("docx-preview");
        await renderAsync(blob, container, undefined, {
          className: "docx-render",
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
        });
      } catch (err) {
        // With responseType "blob", an error response body also arrives as a
        // Blob (axios doesn't auto-parse it as JSON) — read/parse it
        // manually to surface the backend's actual {"detail": "..."}
        // message. Never anything beyond that JSON `detail` string, so no
        // stack trace/internal detail can leak through even if a response
        // body is unexpected.
        let message = "Failed to load document.";
        const errBlob = (err as { response?: { data?: unknown } })?.response?.data;
        if (errBlob instanceof Blob) {
          try {
            const parsed = JSON.parse(await errBlob.text());
            if (typeof parsed?.detail === "string") message = parsed.detail;
          } catch { /* not JSON — keep the generic message */ }
        }
        if (!cancelled) setError(message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileUrl]);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="docx-render-host" />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/80 text-zinc-300 gap-2 text-sm pointer-events-none">
          <Loader2 className="w-4 h-4 animate-spin" /> Rendering document…
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900/90 text-zinc-300 gap-2 text-sm px-6 text-center pointer-events-none">
          <AlertCircle className="w-6 h-6 text-red-400" />
          {error}
        </div>
      )}
    </div>
  );
}
