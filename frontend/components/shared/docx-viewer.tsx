"use client";
// Client-side .docx renderer shared by the eSign document canvas
// (components/signature/pdf-signature-canvas.tsx) and the general Attachment
// Preview modal — extracted from pdf-signature-canvas.tsx so both consumers
// use one implementation instead of two. Fetches the file as a Blob and lets
// the docx-preview package convert it to HTML in-place; no server-side
// rendering, no PDF conversion.
import { useEffect, useRef, useState } from "react";
import { Loader2, AlertCircle } from "lucide-react";

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
        const res = await fetch(fileUrl);
        if (!res.ok) {
          // Backend errors here (e.g. preview-docx's 503 when LibreOffice is
          // unavailable) return a clean {"detail": "..."} body — surface that
          // instead of just the status code, when present. Never anything
          // beyond that JSON `detail` string, so no stack trace/internal
          // detail can leak through even if a response body is unexpected.
          let message = `Failed to load document (${res.status})`;
          try {
            const body = await res.json();
            if (body && typeof body.detail === "string") message = body.detail;
          } catch { /* not JSON — keep the generic message */ }
          throw new Error(message);
        }
        const blob = await res.blob();
        if (cancelled) return;
        const { renderAsync } = await import("docx-preview");
        await renderAsync(blob, container, undefined, {
          className: "docx-render",
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
        });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to render document.");
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
