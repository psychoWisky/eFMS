"use client";
// Client-side XLS/XLSX/CSV -> HTML preview. Spreadsheets are rendered as an
// HTML table (not converted to PDF) specifically so wide sheets keep native
// horizontal/vertical scrolling instead of being paginated — same rationale
// as docx-preview's client-side approach for Word documents (see DocxViewer):
// fetch the raw file, parse/convert entirely in the browser, no backend
// conversion step or stored-format change.
//
// Fetches via the shared `api` axios client (not raw `fetch`) so the
// Authorization header is attached automatically — see docx-viewer.tsx for
// the full rationale (attachment endpoints now require authentication).
import { useEffect, useRef, useState } from "react";
import { Loader2, AlertCircle } from "lucide-react";
import { api } from "@/services/api";

interface Props {
  fileUrl: string;
}

export default function SheetViewer({ fileUrl }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const workbookRef = useRef<import("xlsx").WorkBook | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSheetNames([]);
    setActiveSheet(0);
    workbookRef.current = null;

    (async () => {
      try {
        const res = await api.get(fileUrl, { responseType: "blob" });
        const data = await (res.data as Blob).arrayBuffer();
        if (cancelled) return;
        const XLSX = await import("xlsx");
        const workbook = XLSX.read(data, { type: "array" });
        if (cancelled) return;
        if (workbook.SheetNames.length === 0) throw new Error("This spreadsheet has no sheets.");
        workbookRef.current = workbook;
        setSheetNames(workbook.SheetNames);
      } catch (err) {
        let message = err instanceof Error ? err.message : "Failed to render spreadsheet.";
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
  }, [fileUrl]);

  useEffect(() => {
    const container = containerRef.current;
    const workbook = workbookRef.current;
    if (!container || !workbook || sheetNames.length === 0) return;

    (async () => {
      const XLSX = await import("xlsx");
      const sheet = workbook.Sheets[sheetNames[activeSheet]];
      container.innerHTML = XLSX.utils.sheet_to_html(sheet, { id: "sheet-preview-table" });
    })();
  }, [sheetNames, activeSheet]);

  return (
    <div className="relative w-full h-full bg-white">
      {sheetNames.length > 1 && (
        <div className="flex gap-1 border-b border-gray-200 px-2 py-1.5 overflow-x-auto shrink-0">
          {sheetNames.map((name, i) => (
            <button
              key={name}
              onClick={() => setActiveSheet(i)}
              className={`px-2.5 py-1 text-xs font-medium rounded whitespace-nowrap ${
                i === activeSheet ? "bg-[#0D6E6E] text-white" : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <div ref={containerRef} className="sheet-render-host overflow-auto" style={{ maxHeight: "calc(70vh - 40px)" }} />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/90 text-gray-500 gap-2 text-sm pointer-events-none">
          <Loader2 className="w-4 h-4 animate-spin" /> Rendering spreadsheet…
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/95 text-gray-500 gap-2 text-sm px-6 text-center pointer-events-none">
          <AlertCircle className="w-6 h-6 text-red-400" />
          {error}
        </div>
      )}
    </div>
  );
}
