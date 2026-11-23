"use client";
// Shows a PDF page by page (scrollable, fit to width) so the signer can scroll
// to any page and click exactly where the signature box should go. The box is
// drawn at the real size of the stamp the server creates (BOX_* in
// backend/app/utils/dsc.py), so what is placed here is where it is signed.
import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";

export interface PlacedSignature { page: number; pos_x: number; pos_y: number }

// Keep in step with BOX_WIDTH_PT / BOX_HEIGHT_PT in backend/app/utils/dsc.py.
const BOX_W_PT = 150;
const BOX_H_PT = 36;

interface PageInfo { w: number; h: number } // size in PDF points

interface Props {
  pdfData: ArrayBuffer;
  placed: PlacedSignature | null;
  onPlace: (p: PlacedSignature) => void;
  onClear: () => void;
  disabled?: boolean;
}

type PdfDoc = import("pdfjs-dist").PDFDocumentProxy;

export default function PdfPageSigner({ pdfData, placed, onPlace, onClear, disabled }: Props) {
  const holderRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [width, setWidth] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Fit the pages to the available width.
  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(280, Math.min(el.clientWidth - 24, 820)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loaded: PdfDoc | null = null;
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const task = pdfjs.getDocument({ data: pdfData.slice(0) });
        loaded = await task.promise;
        const infos: PageInfo[] = [];
        for (let i = 1; i <= loaded.numPages; i++) {
          const vp = (await loaded.getPage(i)).getViewport({ scale: 1 });
          infos.push({ w: vp.width, h: vp.height });
        }
        if (cancelled) { loaded.destroy(); return; }
        setDoc(loaded); setPages(infos); setError(null);
      } catch {
        if (!cancelled) setError("This PDF could not be displayed.");
      }
    })();
    return () => { cancelled = true; loaded?.destroy(); };
  }, [pdfData]);

  return (
    <div ref={holderRef} className="w-full rounded-lg border border-zinc-300 bg-zinc-200 overflow-y-auto select-none" style={{ maxHeight: "75vh", minHeight: 120 }}>
      {error ? (
        <div className="text-center py-16 text-red-500 text-sm">{error}</div>
      ) : !doc || !width ? (
        <div className="flex items-center justify-center py-16 gap-2 text-gray-500"><Loader2 size={18} className="animate-spin" /> Loading document…</div>
      ) : (
        <div className="flex flex-col items-center gap-4 py-3">
          {pages.map((info, i) => (
            <PageView key={i} doc={doc} pageNo={i + 1} info={info} width={width}
              placed={placed?.page === i + 1 ? placed : null}
              disabled={!!disabled} onPlace={onPlace} onClear={onClear} />
          ))}
        </div>
      )}
    </div>
  );
}

function PageView({ doc, pageNo, info, width, placed, disabled, onPlace, onClear }: {
  doc: PdfDoc; pageNo: number; info: PageInfo; width: number; placed: PlacedSignature | null;
  disabled: boolean; onPlace: (p: PlacedSignature) => void; onClear: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(pageNo <= 2);
  const height = (width * info.h) / info.w;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || visible) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect(); } }, { rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    (async () => {
      const page = await doc.getPage(pageNo);
      const scale = width / info.w;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale: scale * dpr });
      const canvas = canvasRef.current;
      if (!canvas || cancelled) return;
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      task = page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp });
      try { await task.promise; } catch { /* cancelled */ }
    })();
    return () => { cancelled = true; task?.cancel(); };
  }, [visible, doc, pageNo, width, info.w]);

  const click = (e: React.MouseEvent<HTMLDivElement>) => {
    if (disabled) return;
    const r = e.currentTarget.getBoundingClientRect();
    onPlace({
      page: pageNo,
      pos_x: Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)),
      pos_y: Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100)),
    });
  };

  // The stamp as the server will draw it: BOX_W x BOX_H points, centred on the
  // click and kept inside the page.
  const bwPct = (BOX_W_PT / info.w) * 100;
  const bhPct = (BOX_H_PT / info.h) * 100;
  const boxLeft = placed ? Math.max(0, Math.min(100 - bwPct, placed.pos_x - bwPct / 2)) : 0;
  const boxTop = placed ? Math.max(0, Math.min(100 - bhPct, placed.pos_y - bhPct / 2)) : 0;

  return (
    <div className="relative">
      <div className="absolute -top-0 left-0 z-10 text-[10px] bg-zinc-800/80 text-white px-1.5 py-0.5 rounded-br pointer-events-none">Page {pageNo}</div>
      <div ref={wrapRef} onClick={click} className={`relative bg-white shadow ${disabled ? "" : "cursor-crosshair"}`} style={{ width, height }}>
        {visible ? <canvas ref={canvasRef} style={{ width, height, display: "block" }} /> : null}
        {placed && (
          <div className="absolute border-2 border-dashed border-amber-500 bg-amber-100/60 flex items-center justify-center text-[11px] font-semibold text-amber-800 pointer-events-none"
            style={{ left: `${boxLeft}%`, top: `${boxTop}%`, width: `${bwPct}%`, height: `${bhPct}%` }}>
            Signature will be here
          </div>
        )}
        {placed && !disabled && (
          <button type="button" onClick={(e) => { e.stopPropagation(); onClear(); }} title="Remove the signature box"
            className="absolute z-20 w-5 h-5 rounded-full bg-zinc-700 hover:bg-red-600 flex items-center justify-center"
            style={{ left: `calc(${boxLeft + bwPct}% - 10px)`, top: `calc(${boxTop}% - 10px)` }}>
            <X className="w-3 h-3 text-white" />
          </button>
        )}
      </div>
    </div>
  );
}
