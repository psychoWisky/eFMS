"use client";
// General Attachment Preview — the single preview surface for non-natively-
// viewable attachment types (docx/doc/xls/xlsx/csv), reused by the
// attachment list (notesheet-editor.tsx) and the File Tracking History
// timeline (timeline-modal.tsx) so there is exactly one preview
// implementation instead of two. Reuses DocxViewer (shared with the eSign
// feature) and SheetViewer, and the same modal chrome convention as
// TimelineModal (fixed backdrop + white rounded panel).
//
// The `native` (PDF/image) case fetches the attachment as an authenticated
// blob itself (via the shared `api` client) and points the <iframe> at the
// resulting blob: URL — an <iframe src> can't carry an Authorization header,
// so it can no longer point directly at the (now-authenticated)
// /attachments/{id}/view endpoint the way it used to.
import { useEffect, useState } from "react";
import { X, FileX2, Loader2, AlertCircle } from "lucide-react";
import { getAttachmentPreviewKind } from "@/lib/utils";
import { api } from "@/services/api";
import DocxViewer from "@/components/shared/docx-viewer";
import SheetViewer from "@/components/shared/sheet-viewer";

interface PreviewAttachment {
  id: string;
  original_name: string;
  mime_type: string | null;
}

export function AttachmentPreviewModal({
  fileId,
  attachment,
  onClose,
}: {
  fileId: string;
  attachment: PreviewAttachment;
  onClose: () => void;
}) {
  const kind = getAttachmentPreviewKind(attachment);
  const viewUrl = `/efms/files/${fileId}/attachments/${attachment.id}/view`;
  const docxConvertUrl = `/efms/files/${fileId}/attachments/${attachment.id}/preview-docx`;

  const [nativeBlobUrl, setNativeBlobUrl] = useState<string | null>(null);
  const [nativeError, setNativeError] = useState<string | null>(null);

  useEffect(() => {
    if (kind !== "native") return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setNativeBlobUrl(null);
    setNativeError(null);
    (async () => {
      try {
        const res = await api.get(viewUrl, { responseType: "blob" });
        if (cancelled) return;
        objectUrl = URL.createObjectURL(res.data as Blob);
        setNativeBlobUrl(objectUrl);
      } catch (err) {
        let msg = "Could not load this attachment.";
        const errBlob = (err as { response?: { data?: unknown } })?.response?.data;
        if (errBlob instanceof Blob) {
          try {
            const parsed = JSON.parse(await errBlob.text());
            if (typeof parsed?.detail === "string") msg = parsed.detail;
          } catch { /* not JSON — keep the generic message */ }
        }
        if (!cancelled) setNativeError(msg);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, viewUrl]);

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between shrink-0">
          <h3 className="text-base font-bold text-gray-900 truncate pr-4">{attachment.original_name}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 shrink-0"><X size={20} /></button>
        </div>

        <div className="flex-1 overflow-auto">
          {kind === "docx" && <DocxViewer fileUrl={viewUrl} />}
          {kind === "doc" && <DocxViewer fileUrl={docxConvertUrl} />}
          {kind === "sheet" && <SheetViewer fileUrl={viewUrl} />}
          {kind === "native" && (
            nativeError ? (
              <div className="flex flex-col items-center justify-center py-24 text-gray-400 gap-2">
                <AlertCircle size={40} className="opacity-40 text-red-400" />
                <p className="text-sm">{nativeError}</p>
              </div>
            ) : nativeBlobUrl ? (
              <iframe src={nativeBlobUrl} className="w-full h-full" style={{ minHeight: "70vh", border: "none" }} title={attachment.original_name} />
            ) : (
              <div className="flex items-center justify-center py-24 text-gray-400 gap-2 text-sm">
                <Loader2 size={20} className="animate-spin" /> Loading…
              </div>
            )
          )}
          {kind === "none" && (
            <div className="flex flex-col items-center justify-center py-24 text-gray-400 gap-2">
              <FileX2 size={40} className="opacity-40" />
              <p className="text-sm">Preview is not available for this file type.</p>
              <p className="text-xs">Please download the file to view it.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
