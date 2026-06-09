"use client";
import { useState, useRef, useCallback } from "react";
import { CheckCircle, HelpCircle, X, Move } from "lucide-react";

export interface SignatureStamp {
  id?: string;
  pos_x: number;  // 0–100 percent of container width
  pos_y: number;  // 0–100 percent of container height
  page_number: number;
  status: "pending" | "verified";
  signer_name?: string;
  verified_at?: string;
}

interface Props {
  pdfUrl: string;
  existingSignatures: SignatureStamp[];
  /** Called when user clicks to place a new stamp (returns percent position) */
  onPlace: (pos_x: number, pos_y: number) => void;
  /** Pending stamp placed but not yet OTP-verified */
  pendingStamp: { pos_x: number; pos_y: number } | null;
  onClearPending: () => void;
  readOnly?: boolean;
}

export default function PdfSignatureCanvas({
  pdfUrl,
  existingSignatures,
  onPlace,
  pendingStamp,
  onClearPending,
  readOnly = false,
}: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [dragPos, setDragPos] = useState<{ pos_x: number; pos_y: number } | null>(null);

  const toPercent = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    return { pos_x: Math.max(0, Math.min(100, x)), pos_y: Math.max(0, Math.min(100, y)) };
  }, []);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (readOnly || dragging) return;
    const pos = toPercent(e);
    if (!pos) return;
    onPlace(pos.pos_x, pos.pos_y);
  };

  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
  };

  const handleDragMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const pos = toPercent(e);
    if (pos) setDragPos(pos);
  };

  const handleDragEnd = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    const pos = toPercent(e);
    if (pos) onPlace(pos.pos_x, pos.pos_y);
    setDragPos(null);
  };

  const activeStamp = dragging && dragPos ? dragPos : pendingStamp;

  return (
    <div className="relative w-full rounded-lg overflow-hidden border border-zinc-700 bg-zinc-900 select-none">
      {/* PDF viewer */}
      <iframe
        src={pdfUrl}
        className="w-full"
        style={{ height: "70vh", border: "none" }}
        title="Document"
      />

      {/* Transparent click overlay */}
      <div
        ref={overlayRef}
        className={`absolute inset-0 ${readOnly ? "pointer-events-none" : "cursor-crosshair"}`}
        onClick={handleClick}
        onMouseMove={handleDragMove}
        onMouseUp={handleDragEnd}
        onMouseLeave={() => { if (dragging) { setDragging(false); setDragPos(null); } }}
      >
        {/* Existing verified/pending signature stamps */}
        {existingSignatures.map((sig) => (
          <SignStamp
            key={sig.id}
            stamp={sig}
            onDragStart={undefined}
          />
        ))}

        {/* Pending stamp being placed */}
        {activeStamp && (
          <div
            style={{ left: `${activeStamp.pos_x}%`, top: `${activeStamp.pos_y}%` }}
            className="absolute -translate-x-1/2 -translate-y-1/2 z-20"
          >
            <div className="relative flex flex-col items-center gap-1">
              <div
                className="w-11 h-11 rounded-full bg-amber-500/20 border-2 border-amber-400 border-dashed flex items-center justify-center shadow-lg animate-pulse cursor-move"
                onMouseDown={handleDragStart}
                title="Drag to reposition"
              >
                <HelpCircle className="w-6 h-6 text-amber-400" />
              </div>
              <span className="text-[10px] text-amber-300 bg-zinc-900/90 px-1 rounded whitespace-nowrap">
                Pending — drag to reposition
              </span>
              {!readOnly && (
                <button
                  onClick={(e) => { e.stopPropagation(); onClearPending(); }}
                  className="absolute -top-2 -right-3 w-4 h-4 rounded-full bg-zinc-700 flex items-center justify-center hover:bg-red-600"
                  title="Remove stamp"
                >
                  <X className="w-2.5 h-2.5 text-white" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {!readOnly && !pendingStamp && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-xs text-zinc-400 bg-zinc-900/80 px-3 py-1 rounded-full pointer-events-none">
          Click anywhere on the document to place your signature
        </div>
      )}
    </div>
  );
}

function SignStamp({ stamp }: { stamp: SignatureStamp; onDragStart?: undefined }) {
  const isVerified = stamp.status === "verified";
  return (
    <div
      style={{ left: `${stamp.pos_x}%`, top: `${stamp.pos_y}%` }}
      className="absolute -translate-x-1/2 -translate-y-1/2 z-10 group"
    >
      <div className="flex flex-col items-center gap-0.5">
        <div
          className={`w-10 h-10 rounded-full border-2 flex items-center justify-center shadow-md transition-all
            ${isVerified
              ? "bg-emerald-500/20 border-emerald-400"
              : "bg-amber-500/20 border-amber-400 border-dashed animate-pulse"
            }`}
          title={isVerified ? `Signed by ${stamp.signer_name}` : "Pending OTP verification"}
        >
          {isVerified
            ? <CheckCircle className="w-5 h-5 text-emerald-400" />
            : <HelpCircle className="w-5 h-5 text-amber-400" />
          }
        </div>
        {/* Tooltip on hover */}
        <div className="hidden group-hover:flex flex-col items-center pointer-events-none z-30">
          <div className="bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-[10px] text-zinc-200 whitespace-nowrap shadow-xl mt-1">
            {isVerified ? (
              <>
                <span className="text-emerald-400 font-semibold">✓ Verified</span>
                <br />{stamp.signer_name}
              </>
            ) : (
              <span className="text-amber-400">? Awaiting OTP</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
