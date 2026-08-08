"use client";
// General Attachment Preview — the single preview surface for non-natively-
// viewable attachment types (docx/doc/xls/xlsx/csv), reused by the
// attachment list (notesheet-editor.tsx) and the File Tracking History
// timeline (timeline-modal.tsx) so there is exactly one preview
// implementation instead of two. PDF/images/text are unaffected — those
// keep opening directly via the existing /view endpoint in a new tab.
// Reuses DocxViewer (shared with the eSign feature) and SheetViewer, and the
// same modal chrome convention as TimelineModal (fixed backdrop + white
// rounded panel).
import { X, FileX2 } from "lucide-react";
import { getAttachmentPreviewKind } from "@/lib/utils";
import { API_URL } from "@/services/api";
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
  const viewUrl = `/api/attachments/${fileId}/${attachment.id}/view`;
  const docxConvertUrl = `${API_URL}/efms/files/${fileId}/attachments/${attachment.id}/preview-docx`;

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
            <iframe src={viewUrl} className="w-full h-full" style={{ minHeight: "70vh", border: "none" }} title={attachment.original_name} />
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
