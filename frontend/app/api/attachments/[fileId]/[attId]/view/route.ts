import { NextRequest, NextResponse } from "next/server";

// Force IPv4 loopback: Node's fetch resolves "localhost" to ::1 first, which
// hangs when the backend (uvicorn) only binds to 0.0.0.0 (IPv4).
const BACKEND =
  process.env.INTERNAL_API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://127.0.0.1:8001/api/v1";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ fileId: string; attId: string }> }
) {
  const { fileId, attId } = await params;
  const upstream = `${BACKEND}/efms/files/${fileId}/attachments/${attId}/view`;

  const res = await fetch(upstream);
  if (!res.ok) {
    return new NextResponse(await res.text(), { status: res.status });
  }

  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  return new NextResponse(res.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      // No Content-Disposition — browser renders inline (same-origin, Chrome allows it)
    },
  });
}
