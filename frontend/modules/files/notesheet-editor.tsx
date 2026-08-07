"use client";
// File detail view: left panel = PDF attachments, main = forwarding remarks thread + notesheet + track status
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, FILES_BASE_URL, API_URL } from "@/services/api";
import { toast } from "sonner";
import { confirmAction, showSuccess, escapeHtml } from "@/lib/alert";
import { useUser, useActiveRole } from "@/stores/auth.store";
import { cn, formatDate, isPreviewable } from "@/lib/utils";
import {
  ChevronLeft, FileText, Download, ArrowRight,
  Loader2, Lock, Clock, MessageSquare, Upload, X, PenLine,
  CheckCircle2, XCircle, Trash2, Pencil, Save,
} from "lucide-react";
import PdfSignatureCanvas, { type SignatureStamp } from "@/components/signature/pdf-signature-canvas";
import OtpVerifyModal from "@/components/signature/otp-verify-modal";
import { PersonBadge, type PersonInfo } from "@/components/shared/person-badge";
import { FileClassificationBadge, FileClassificationBanner } from "@/components/shared/file-classification-badge";
import { SearchableSelect } from "@/components/shared/searchable-select";
import { useRichTextEditor, RichTextToolbar } from "@/components/shared/rich-text-editor";
import { EditorContent } from "@tiptap/react";
import { useFavoriteRecipients, type FavoritableUser } from "@/hooks/use-favorite-recipients";
import { useAttachmentQueue } from "@/hooks/use-attachment-queue";
import { ALLOWED_ATTACHMENT_ACCEPT } from "@/lib/attachment-constants";

const DRAFT_EDIT_WINDOW_MS = 30 * 60 * 1000;
const ATTACHMENT_DELETE_WINDOW_MS = 5 * 60 * 1000;

// Compact prose styling for rendering stored notesheet HTML inside a
// Notesheet History card (smaller than the main Initial Notesheet document,
// since these sit inside a timeline entry rather than being the page's
// primary content).
const NOTESHEET_PROSE_CLASS = "prose prose-sm max-w-none leading-relaxed " +
  "[&_h1]:text-lg [&_h1]:font-bold [&_h1]:mt-2 [&_h1]:mb-1 " +
  "[&_h2]:text-base [&_h2]:font-bold [&_h2]:mt-2 [&_h2]:mb-1 " +
  "[&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-1.5 [&_h3]:mb-1 " +
  "[&_p]:mb-2 [&_ol]:pl-5 [&_ul]:pl-5 [&_li]:mb-0.5 [&_strong]:font-bold";

// RouteEntry.remarks holds two eras of data in the same plain-text column:
// HTML from the Rich Text Editor (current) and legacy plain text from the
// pre-editor <textarea> (historical). Detect which one a given value is and
// normalize both to safe HTML for a single dangerouslySetInnerHTML render
// path — no duplicate rendering component, no backend/data change.
const HTML_TAG_PATTERN = /<([a-z][a-z0-9]*)\b[^>]*>/i;

function toSafeNotesheetHtml(raw: string): string {
  if (HTML_TAG_PATTERN.test(raw)) return raw; // Rich Text Editor output — already safe HTML, render as-is.
  return escapeHtml(raw).replace(/\r\n|\r|\n/g, "<br />"); // Legacy plain text — escape, then preserve line breaks.
}

interface RouteEntry { id: string; from_user_id: string | null; to_user_id: string | null; action: string; remarks: string | null; is_current: boolean; created_at: string; from_user_info?: PersonInfo | null; to_user_info?: PersonInfo | null; }
interface TrackEntry { id: string; type?: "route" | "sign"; from_user_id: string | null; to_user_id: string | null; from_user_name: string | null; to_user_name: string | null; from_user_info?: PersonInfo | null; to_user_info?: PersonInfo | null; action: string; remarks: string | null; is_current: boolean; created_at: string; }
interface Attachment { id: string; original_name: string; file_size: number | null; mime_type: string | null; stored_name: string; created_at: string; uploaded_by: string; }
interface Notesheet { id: string; content: string; version: number; is_locked: boolean; }
interface Signature { id: string; file_id: string; user_id: string; signer_name: string; signer_info?: PersonInfo | null; pos_x: number; pos_y: number; page_number: number; status: "pending" | "verified"; signed_at: string | null; verified_at: string | null; }
interface EfmsFile {
  id: string; ref_number: string; subject: string; category: string;
  status: string; priority: string; is_confidential: boolean;
  created_by: string; current_holder_id: string | null;
  department_id: string | null;
  recipient_id: string | null; recipient_name: string | null;
  created_at: string; updated_at: string;
  is_released: boolean;
  creator_info?: PersonInfo | null; current_holder_info?: PersonInfo | null; recipient_info?: PersonInfo | null;
  notesheet: Notesheet | null; route_entries: RouteEntry[]; attachments: Attachment[];
  signatures: Signature[];
}
interface ForwardingRemark { id: string; remark: string; user_name: string; user_id: string; created_at: string; user_info?: PersonInfo | null; to_user_info?: PersonInfo | null; }
interface SystemUser extends FavoritableUser { email: string; active_role: string | null; }
interface DropItem { id: string; name: string; label?: string; is_active?: boolean; }
interface DeptItem { id: string; name: string; }

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  draft:      { bg: "bg-gray-100",  text: "text-gray-700",  label: "Draft" },
  active:     { bg: "bg-amber-100", text: "text-amber-800", label: "Active" },
  released:   { bg: "bg-green-100", text: "text-green-800", label: "Released" },
  dispatched: { bg: "bg-teal-100",  text: "text-teal-800",  label: "Dispatched" },
};

function daysElapsed(d: string) { return Math.floor((Date.now() - new Date(d).getTime()) / 86400000); }

export function NotesheetPage({ fileId }: { fileId: string }) {
  const router = useRouter();
  const user = useUser();
  const role = useActiveRole();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<"notesheet" | "track" | "sign">("notesheet");
  // First-forward (Draft -> Active): confirmation-only, no recipient/notesheet re-entry.
  // Subsequent forwards: inline recipient + notesheet-entry panel (no modal).
  const [toUserId, setToUserId] = useState("");
  const [remarks, setRemarks] = useState("");
  const forwardAttachments = useAttachmentQueue();
  const { toggleFavorite, buildGroups } = useFavoriteRecipients();
  // Draft editing (30-minute window)
  const [editingDraft, setEditingDraft] = useState(false);
  const [draftSubject, setDraftSubject] = useState("");
  const [draftDepartmentId, setDraftDepartmentId] = useState("");
  const [draftCategory, setDraftCategory] = useState("");
  const [draftPriority, setDraftPriority] = useState("");
  const [draftRecipientId, setDraftRecipientId] = useState("");
  const [draftNotesheet, setDraftNotesheet] = useState("");
  // Ticks every 30s so edit/delete windows expire live without a manual refresh.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  // Signature state
  const [pendingStamp, setPendingStamp] = useState<{ pos_x: number; pos_y: number } | null>(null);
  const [pendingSignatureId, setPendingSignatureId] = useState<string | null>(null);
  const [showOtpModal, setShowOtpModal] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpLoading, setOtpLoading] = useState(false);
  const [actionType] = useState<"forward">("forward");
  const [selectedPdf, setSelectedPdf] = useState<Attachment | null>(null);

  const { data: file, isLoading, isError } = useQuery<EfmsFile>({
    queryKey: ["efms-file", fileId],
    queryFn: async () => (await api.get(`/efms/files/${fileId}`)).data,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  const { data: forwardingRemarks = [] } = useQuery<ForwardingRemark[]>({
    queryKey: ["file-remarks", fileId],
    queryFn: async () => (await api.get(`/docket/remarks/${fileId}`)).data,
  });

  const { data: trackEntries = [] } = useQuery<TrackEntry[]>({
    queryKey: ["file-track", fileId],
    queryFn: async () => (await api.get(`/efms/files/${fileId}/track`)).data,
    enabled: activeTab === "track",
  });

  const { data: users = [] } = useQuery<SystemUser[]>({
    queryKey: ["admin-users"],
    queryFn: async () => (await api.get("/admin/users")).data,
  });

  // Draft-edit dropdown sources — same endpoints New File creation already uses.
  const { data: departments = [] } = useQuery<DeptItem[]>({
    queryKey: ["admin-departments"],
    queryFn: async () => (await api.get("/admin/departments")).data,
    enabled: editingDraft,
  });
  const { data: categories = [] } = useQuery<DropItem[]>({
    queryKey: ["admin-categories"],
    queryFn: async () => (await api.get("/admin/categories")).data,
    enabled: editingDraft,
  });
  const { data: priorities = [] } = useQuery<DropItem[]>({
    queryKey: ["admin-priorities"],
    queryFn: async () => (await api.get("/admin/priorities")).data,
    enabled: editingDraft,
  });

  const isHolder = file?.current_holder_id === user?.id;
  const isCreator = file?.created_by === user?.id;
  const isDraft = file?.status === "draft";
  const isTerminal = file?.status === "dispatched";
  const isReleased = file?.is_released ?? false;
  // Backend is the real enforcement (DRAFT_EDIT_WINDOW); this mirrors it
  // client-side purely so the Edit Draft affordance disappears on its own.
  const draftEditExpired = file ? Date.now() - new Date(file.created_at).getTime() > DRAFT_EDIT_WINDOW_MS : true;
  const canEditDraft = isDraft && isCreator && !draftEditExpired;
  // Whole-file deletion (distinct from Edit Draft/attachment delete): creator,
  // still a Draft, never forwarded. Not time-gated — a draft that's expired
  // its edit window must still have an escape hatch (delete or forward),
  // otherwise it gets permanently stuck. Backend (_delete_draft_file) is the
  // real enforcement; this only hides/shows the button to match it.
  const canDeleteDraft = isDraft && isCreator && (file?.route_entries.length ?? 0) === 0;
  // Released overrides the underlying workflow status for display purposes.
  const displayStatus = isReleased ? "released" : (file?.status ?? "draft");
  // Quick one-click forward: window still open, recipient already on record —
  // Edit Draft remains the single path to set/change it while editable.
  const canForwardDraft = isHolder && isDraft && !draftEditExpired && !!file?.recipient_id;
  // Once the edit window closes, Edit Draft (and with it, the only place
  // recipient selection normally lives) disappears. Routing must still work,
  // so a recipient-only picker takes over here — pre-filled with the existing
  // recipient if any, changeable, with no document/notesheet editing exposed.
  // This is deliberately NOT the same "Forward This File" panel used below for
  // subsequent forwards: that panel also exposes a remarks/notesheet editor,
  // which would violate "document editing must remain locked."
  const needsRecipientPicker = isHolder && isDraft && draftEditExpired;
  // Subsequent forwards only (never for a still-draft file) — recipient +
  // notesheet-entry + attachments, unrelated to the draft-edit window.
  const canForwardAfter = isHolder && !isDraft && !isTerminal && !isReleased;
  // Released files can no longer be forwarded from here — the only supported
  // way to move a released file again is to reopen it via New File -> Use
  // Existing Released File (creator-only), which restores current_holder_id.

  // Latest route entry (route_entries is ordered by created_at on the
  // backend) tells us who most recently forwarded the file to whoever holds
  // it now — the recipient chosen at creation time is not the right answer
  // once routing has actually started, and must never be shown as "From".
  const latestRouteEntry = file?.route_entries.length
    ? (file.route_entries.find((e) => e.is_current) ?? file.route_entries[file.route_entries.length - 1])
    : null;

  // Single routing mutation, reused by both the first-forward confirm dialog
  // and the subsequent-forward panel — the endpoint and payload shape are
  // unchanged; only what populates `remarks`/`to_user_id` differs by caller.
  const submitAction = useMutation({
    mutationFn: (data: { action: string; remarks: string; to_user_id?: string | null }) =>
      api.post(`/efms/files/${fileId}/route`, data),
  });

  async function afterForwardSuccess() {
    showSuccess("File forwarded.");
    setRemarks(""); setToUserId("");
    if (forwardDraftKey) localStorage.removeItem(forwardDraftKey);
    qc.invalidateQueries({ queryKey: ["efms-file", fileId] });
    qc.invalidateQueries({ queryKey: ["efms-files"] });
    qc.invalidateQueries({ queryKey: ["efms-files-outbox"] });
    qc.invalidateQueries({ queryKey: ["my-docket"] });
    qc.invalidateQueries({ queryKey: ["docket-released"] });
    qc.invalidateQueries({ queryKey: ["notifications"] });
    // After a successful forward the file leaves this user's hands — send
    // them to the Docket rather than leaving them on the (now read-only) page.
    router.push("/dashboard");
  }

  // First forward (Draft -> Active): no notesheet re-entry — reuses the
  // recipient already stored on the draft (file.recipient_id) by default, or
  // an explicit recipientId when called from the post-window recipient-only
  // picker (needsRecipientPicker), which lets the user pick/change one even
  // though the rest of the draft is locked.
  async function handleFirstForward(recipientId?: string) {
    const target = recipientId ?? file?.recipient_id;
    if (!target) return;
    try {
      await submitAction.mutateAsync({ action: actionType, remarks: "", to_user_id: target });
      await afterForwardSuccess();
    } catch (err) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(msg ?? "Action failed.");
    }
  }

  // Subsequent forwards: recipient + notesheet entry chosen inline in the
  // panel. Attachments are no longer uploaded here — the Forward panel now
  // uploads each file immediately on selection (see forwardAttachments.uploadNow
  // in the file input below), so they're already persisted before this runs.
  // Confirmed via the shared confirmAction() (lib/alert.ts) before the API
  // call actually runs — same pattern as every other forward/delete action.
  async function handleSubmitAction() {
    if (!toUserId) { toast.warning("Please select a person to forward to."); return; }
    const selected = users.find((u) => u.id === toUserId);
    const confirmed = await confirmAction({
      title: "Forward File",
      html: `Are you sure you want to forward this file to <strong>${escapeHtml(selected?.full_name ?? "the selected recipient")}</strong>?`,
      confirmText: "Forward",
    });
    if (!confirmed) return;
    try {
      await submitAction.mutateAsync({ action: actionType, remarks, to_user_id: toUserId || null });
      await afterForwardSuccess();
    } catch (err) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(msg ?? "Action failed.");
    }
  }

  // Draft editing — reuses the existing PATCH .../{id} and PATCH .../notesheet
  // endpoints; no new API. Only the file creator, within DRAFT_EDIT_WINDOW.
  const updateFileMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => api.patch(`/efms/files/${fileId}`, data),
  });
  const updateNotesheetMutation = useMutation({
    mutationFn: (content: string) => api.patch(`/efms/files/${fileId}/notesheet`, { content }),
  });

  // Permanent whole-file delete — reuses DELETE /efms/files/{id}. Backend is
  // the source of truth for creator/draft/never-forwarded/30-min checks;
  // canDeleteDraft above only hides the button, it never authorizes the call.
  const deleteFileMutation = useMutation({
    mutationFn: () => api.delete(`/efms/files/${fileId}`),
  });

  async function handleDeleteDraft() {
    const confirmed = await confirmAction({
      title: "Delete this draft file?",
      text: "This will permanently delete the entire file, including its notesheet and attachments. This cannot be undone.",
      confirmText: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await deleteFileMutation.mutateAsync();
      showSuccess("Draft file deleted.");
      qc.invalidateQueries({ queryKey: ["efms-files"] });
      qc.invalidateQueries({ queryKey: ["efms-files-outbox"] });
      qc.invalidateQueries({ queryKey: ["my-docket"] });
      router.push("/dashboard");
    } catch (err) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(msg ?? "Could not delete this file.");
    }
  }

  async function handleSaveDraft() {
    try {
      await updateFileMutation.mutateAsync({
        subject: draftSubject,
        category: draftCategory,
        priority: draftPriority,
        department_id: draftDepartmentId || null,
        recipient_id: draftRecipientId || null,
      });
      await updateNotesheetMutation.mutateAsync(draftNotesheet);
      showSuccess("Draft updated.");
      setEditingDraft(false);
      qc.invalidateQueries({ queryKey: ["efms-file", fileId] });
    } catch (err) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(msg ?? "Could not save draft changes.");
    }
  }

  function openEditDraft() {
    if (!file) return;
    setDraftSubject(file.subject);
    setDraftDepartmentId(file.department_id ?? "");
    setDraftCategory(file.category);
    setDraftPriority(file.priority);
    setDraftRecipientId(file.recipient_id ?? "");
    setDraftNotesheet(file.notesheet?.content ?? "");
    setEditingDraft(true);
  }

  // Attachment deletion — reuses the existing DELETE endpoint; the backend
  // enforces uploader-only + 5-minute window, this mirrors it client-side
  // only to hide/disable the button.
  const deleteAttachmentMutation = useMutation({
    mutationFn: (attId: string) => api.delete(`/efms/files/${fileId}/attachments/${attId}`),
    onSuccess: () => {
      showSuccess("Attachment deleted.");
      qc.invalidateQueries({ queryKey: ["efms-file", fileId] });
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(msg ?? "Could not delete attachment.");
    },
  });

  const draftEditor = useRichTextEditor({ content: draftNotesheet, onChange: setDraftNotesheet, editable: true });
  useEffect(() => {
    if (editingDraft && draftEditor && draftEditor.getHTML() !== draftNotesheet) {
      draftEditor.commands.setContent(draftNotesheet);
    }
    // Only re-sync when the panel opens — not on every keystroke, which would fight the editor's own state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingDraft]);

  // Pre-fill the recipient-only picker (needsRecipientPicker) with whatever
  // recipient is already on the draft, if any — the user can still change it.
  useEffect(() => {
    if (needsRecipientPicker && file?.recipient_id && !toUserId) {
      setToUserId(file.recipient_id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsRecipientPicker, file?.recipient_id]);

  // Forward panel's notesheet entry — same shared editor as Initial Notesheet
  // and Edit Draft, just a second independent instance (its own empty
  // starting content, cleared after each successful forward).
  const forwardEditor = useRichTextEditor({ content: "", onChange: setRemarks, editable: true });

  // In-progress forward notesheet entry survives closing the page before
  // actually forwarding — same localStorage autosave pattern already used
  // by New File creation (DRAFT_KEY), just scoped per file + holder instead
  // of a single global key. Attachments don't need this: they now upload
  // immediately (see the Forward panel's file input) instead of being queued
  // client-side, so they're already persisted server-side as soon as chosen.
  const forwardDraftKey = user?.id ? `efms-forward-draft-${fileId}-${user.id}` : null;

  useEffect(() => {
    if (!canForwardAfter || !forwardDraftKey || !forwardEditor) return;
    const saved = localStorage.getItem(forwardDraftKey);
    if (!saved) return;
    try {
      const { content } = JSON.parse(saved);
      if (content) { forwardEditor.commands.setContent(content); setRemarks(content); }
    } catch { /* ignore */ }
    // Restore once, when the forward panel first becomes available for this file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canForwardAfter, forwardDraftKey]);

  useEffect(() => {
    if (!canForwardAfter || !forwardDraftKey) return;
    const id = setInterval(() => {
      localStorage.setItem(forwardDraftKey, JSON.stringify({ content: remarks }));
    }, 30_000);
    return () => clearInterval(id);
  }, [canForwardAfter, forwardDraftKey, remarks]);

  useEffect(() => {
    if (file?.attachments.length && !selectedPdf) setSelectedPdf(file.attachments[0]);
  }, [file]);

  if (isLoading) return <div className="flex items-center justify-center py-24 gap-3 text-gray-400"><Loader2 size={24} className="animate-spin" /> Loading file…</div>;
  if (isError || !file) return (
    <div className="flex flex-col items-center justify-center py-24 text-gray-400">
      <XCircle size={40} className="mb-3 text-red-300" />
      <p className="text-xl font-semibold">File not found or access denied</p>
      <button onClick={() => router.back()} className="mt-4 text-[#0D6E6E] hover:underline text-base">← Go back</button>
    </div>
  );

  const statusStyle = STATUS_STYLES[displayStatus] ?? STATUS_STYLES.draft;
  const days = daysElapsed(file.created_at);

  return (
    <div className="flex h-screen bg-[#F5F7FA] overflow-hidden -mt-0">
      {/* Left panel: PDF attachments */}
      <div className="w-72 shrink-0 bg-white border-r border-gray-200 flex flex-col">
        <div className="px-4 py-4 border-b border-gray-200">
          <button onClick={() => router.back()} className="flex items-center gap-1 text-sm text-[#0D6E6E] hover:underline mb-3">
            <ChevronLeft size={14} /> Back
          </button>
          <h2 className="text-base font-bold text-gray-900">Attached Files</h2>
          <p className="text-xs text-gray-400 mt-0.5">PDF versions for download</p>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {file.attachments.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No attachments</p>
          ) : (
            file.attachments.map((att) => {
              // Backend is the real enforcement (uploader-only + 5 minutes +
              // still-current-holder); this mirrors it client-side purely to
              // hide/disable the button. Deletion must stop the moment the
              // file is forwarded on, even if the 5-minute window hasn't
              // elapsed yet — the uploader is no longer the current holder.
              const canDelete = att.uploaded_by === user?.id
                && isHolder
                && Date.now() - new Date(att.created_at).getTime() < ATTACHMENT_DELETE_WINDOW_MS;
              return (
              <div key={att.id}
                className={cn("w-full flex items-start gap-3 p-3 rounded-xl border text-left transition-all",
                  selectedPdf?.id === att.id ? "border-[#0D6E6E] bg-[#E6F4F4]" : "border-gray-100 bg-gray-50")}>
                <FileText size={18} className="text-[#0D6E6E] shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">{att.original_name}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{att.file_size ? `${(att.file_size/1024).toFixed(0)} KB · ` : ""}{formatDate(att.created_at, "relative")}</p>
                  <div className="flex items-center gap-3 mt-2">
                    {isPreviewable(att) ? (
                      <a
                        href={`/api/attachments/${fileId}/${att.id}/view`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={() => setSelectedPdf(att)}
                        className="text-xs text-[#0D6E6E] font-semibold hover:underline"
                      >
                        View
                      </a>
                    ) : (
                      <span
                        title="Preview is not available for this file type. Please download the file to view it."
                        className="text-xs text-gray-400 cursor-default"
                      >
                        No preview
                      </span>
                    )}
                    <a
                      href={`${API_URL}/efms/files/${fileId}/attachments/${att.id}/download`}
                      className="text-xs text-gray-500 hover:text-gray-700 hover:underline"
                    >
                      Download
                    </a>
                    {canDelete && (
                      <button
                        type="button"
                        onClick={async () => {
                          const confirmed = await confirmAction({
                            title: "Delete this attachment?",
                            text: `"${att.original_name}" will be permanently removed from this file.`,
                            confirmText: "Delete",
                            danger: true,
                          });
                          if (confirmed) deleteAttachmentMutation.mutate(att.id);
                        }}
                        disabled={deleteAttachmentMutation.isPending}
                        className="text-xs text-red-400 hover:text-red-600 flex items-center gap-1 ml-auto disabled:opacity-50"
                      >
                        <Trash2 size={12} /> Delete
                      </button>
                    )}
                  </div>
                </div>
              </div>
              );
            })
          )}
        </div>
        {selectedPdf && (
          <div className="p-3 border-t border-gray-200">
            <a href={`${API_URL}/efms/files/${fileId}/attachments/${selectedPdf.id}/download`}
              className="flex items-center justify-center gap-2 w-full py-2.5 bg-[#0D6E6E] text-white rounded-xl text-sm font-semibold hover:bg-[#178F8F]">
              <Download size={15} /> Download
            </a>
          </div>
        )}
      </div>

      {/* Main panel */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* File header */}
        <div className="bg-white border-b border-gray-200 px-6 py-4">
          {(file.priority === "secret" || file.priority === "urgent") && (
            <div className="mb-3"><FileClassificationBanner priority={file.priority} /></div>
          )}
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="font-mono text-sm font-bold text-[#0D6E6E] bg-[#E6F4F4] px-2 py-0.5 rounded">{file.ref_number}</span>
                <span className={cn("px-2 py-0.5 rounded-full text-sm font-semibold", statusStyle.bg, statusStyle.text)}>{statusStyle.label}</span>
                <FileClassificationBadge priority={file.priority} />
                <span className={cn("text-sm font-semibold px-2 py-0.5 rounded-full",
                  days > 7 ? "text-red-600 bg-red-50" : days > 3 ? "text-amber-600 bg-amber-50" : "text-green-600 bg-green-50")}>
                  {days}d elapsed
                </span>
              </div>
              <h1 className="text-xl font-bold text-gray-900 truncate">{file.subject}</h1>
              <p className="text-sm text-gray-500 mt-0.5">{file.category} · Created {formatDate(file.created_at, "relative")}</p>
              <div className="flex flex-wrap items-start gap-x-6 gap-y-1.5 mt-2">
                {latestRouteEntry?.from_user_info ? (
                  <div className="flex items-start gap-1.5">
                    <span className="text-xs font-semibold text-gray-400 uppercase mt-0.5">From</span>
                    <PersonBadge person={latestRouteEntry.from_user_info} compact />
                  </div>
                ) : (
                  <div className="flex items-start gap-1.5">
                    <span className="text-xs font-semibold text-gray-400 uppercase mt-0.5">From</span>
                    <span className="text-sm text-gray-400 italic mt-0.5">Not yet forwarded</span>
                  </div>
                )}
                {file.current_holder_info && (
                  <div className="flex items-start gap-1.5">
                    <span className="text-xs font-semibold text-gray-400 uppercase mt-0.5">Current Holder</span>
                    <PersonBadge person={file.current_holder_info} compact />
                  </div>
                )}
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-2 shrink-0">
              {canEditDraft && (
                <button onClick={openEditDraft}
                  className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 text-gray-700 rounded-xl text-sm font-semibold hover:bg-gray-50">
                  <Pencil size={14} /> Edit Draft
                </button>
              )}
              {canDeleteDraft && (
                <button onClick={handleDeleteDraft} disabled={deleteFileMutation.isPending}
                  className="flex items-center gap-1.5 px-3 py-2 border border-red-200 text-red-600 rounded-xl text-sm font-semibold hover:bg-red-50 disabled:opacity-50">
                  <Trash2 size={14} /> Delete Draft
                </button>
              )}
              {canForwardDraft && (
                <button onClick={async () => {
                  const confirmed = await confirmAction({
                    title: "Forward File",
                    html: `Are you sure you want to forward this file to <strong>${escapeHtml(file?.recipient_info?.full_name ?? "the selected recipient")}</strong>?`,
                    confirmText: "Forward",
                  });
                  if (confirmed) handleFirstForward();
                }}
                  className="flex items-center gap-1.5 px-4 py-2 bg-[#0D6E6E] text-white rounded-xl text-sm font-semibold hover:bg-[#178F8F]">
                  <ArrowRight size={15} /> Forward to Recipient
                </button>
              )}
            </div>
          </div>

          {/* Status tracker bar */}
          <div className={cn("mt-3 rounded-xl px-4 py-3 flex items-center gap-3",
            displayStatus === "released" ? "bg-green-50 border border-green-200" :
            "bg-amber-50 border border-amber-200")}>
            <div className={cn("w-2 h-2 rounded-full shrink-0",
              displayStatus === "released" ? "bg-green-500" : "bg-amber-500")} />
            <p className="text-base text-gray-700">
              {displayStatus === "draft"      ? "Draft — not yet forwarded. Use 'Forward to Recipient' when ready." :
               displayStatus === "active"     ? (isHolder ? "You are the current holder of this file." : "Forwarded — awaiting review by the current holder.") :
               displayStatus === "released"   ? "Released to the department." :
               displayStatus === "dispatched" ? "Officially dispatched." : "Active."}
            </p>
            {!isHolder && <span className="ml-auto text-sm text-gray-400 shrink-0"><Lock size={13} className="inline mr-1" />Read-only</span>}
          </div>

          {/* Tabs */}
          <div className="flex gap-1 mt-3">
            <button onClick={() => setActiveTab("notesheet")}
              className={cn("px-4 py-2 text-sm font-semibold rounded-lg transition-colors",
                activeTab === "notesheet" ? "bg-[#0D6E6E] text-white" : "text-gray-600 hover:bg-gray-100")}>
              <MessageSquare size={13} className="inline mr-1" />Notesheet
            </button>
            <button onClick={() => setActiveTab("track")}
              className={cn("px-4 py-2 text-sm font-semibold rounded-lg transition-colors",
                activeTab === "track" ? "bg-[#0D6E6E] text-white" : "text-gray-600 hover:bg-gray-100")}>
              <Clock size={13} className="inline mr-1" />Track Status
            </button>
            {user?.can_sign && isHolder && (
              <button onClick={() => setActiveTab("sign")}
                className={cn("px-4 py-2 text-sm font-semibold rounded-lg transition-colors flex items-center gap-1",
                  activeTab === "sign" ? "bg-emerald-600 text-white" : "text-emerald-700 hover:bg-emerald-50 border border-emerald-200")}>
                <PenLine size={13} />Sign Document
              </button>
            )}
          </div>
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === "notesheet" && (
            <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-5">
              {/* LEFT: Initial Notesheet + Notesheet History (read-only) */}
              <div className="lg:col-span-2 space-y-5">
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm">
                  <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                    <h2 className="text-lg font-bold text-gray-800">Initial Notesheet</h2>
                    <span className="text-sm text-gray-400 flex items-center gap-1"><Lock size={13} /> Read-only</span>
                  </div>
                  {file.notesheet?.content ? (
                    <div className="px-6 py-5 prose max-w-none text-base leading-relaxed
                      [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mt-4 [&_h1]:mb-2
                      [&_h2]:text-xl [&_h2]:font-bold [&_h2]:mt-4 [&_h2]:mb-2
                      [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1
                      [&_p]:mb-3 [&_ol]:pl-6 [&_ul]:pl-6 [&_li]:mb-1 [&_strong]:font-bold"
                      dangerouslySetInnerHTML={{ __html: file.notesheet.content }} />
                  ) : (
                    <div className="px-6 py-10 text-center text-gray-400">
                      <p className="text-base">No notesheet content provided.</p>
                    </div>
                  )}
                </div>

                {/* Notesheet History — one entry per completed forward (RouteEntry.remarks),
                    same data GET /docket/remarks/{fileId} already returns; only completed
                    forwards ever produce a RouteEntry, so the current user's in-progress
                    entry never appears here until they actually forward. */}
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm">
                  <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <div>
                      <h2 className="text-lg font-bold text-gray-800">Notesheet History</h2>
                      <p className="text-sm text-gray-500 mt-0.5">Every notesheet entry recorded as the file moved, oldest first</p>
                    </div>
                    {forwardingRemarks.filter((r) => r.remark).length > 0 && (
                      <span className="text-xs font-semibold bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full">
                        {forwardingRemarks.filter((r) => r.remark).length} entr{forwardingRemarks.filter((r) => r.remark).length === 1 ? "y" : "ies"}
                      </span>
                    )}
                  </div>
                  {forwardingRemarks.filter((r) => r.remark).length === 0 ? (
                    <div className="px-6 py-10 text-center text-gray-400">
                      <p className="text-base">No notesheet entries recorded yet.</p>
                    </div>
                  ) : (
                    <div className="px-6 py-5">
                      {forwardingRemarks.filter((r) => r.remark).map((r, idx, arr) => (
                        <div key={r.id} className="flex items-start gap-4">
                          {/* Numbered marker + connecting line — same timeline
                              language as the Track Status tab's icon + line. */}
                          <div className="flex flex-col items-center">
                            <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 border-2 bg-[#0D6E6E] border-[#0D6E6E]">
                              <span className="text-xs font-bold text-white">{arr.length - idx}</span>
                            </div>
                            {idx < arr.length - 1 && <div className="w-0.5 flex-1 min-h-[24px] mt-1 bg-gray-200" />}
                          </div>
                          <div className="flex-1 min-w-0 pb-6">
                            <div className="flex items-center justify-end mb-2">
                              <span className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
                                <Clock size={12} className="text-gray-400" />{formatDate(r.created_at, "datetime")}
                              </span>
                            </div>
                            {/* Sender -> Forwarded To -> Recipient, one horizontal row */}
                            <div className="flex items-center gap-3 mb-3">
                              <div className="flex-1 min-w-0">
                                <PersonBadge person={r.user_info} fallback="Unknown" compact />
                                {r.user_id === user?.id && (
                                  <p className="text-xs text-[#0D6E6E] font-medium leading-tight">You</p>
                                )}
                              </div>
                              {r.to_user_info && (
                                <>
                                  <div className="flex flex-col items-center gap-0.5 shrink-0 text-gray-300">
                                    <ArrowRight size={13} />
                                    <span className="text-[10px] font-bold text-gray-400 tracking-wide whitespace-nowrap">FORWARDED TO</span>
                                    <ArrowRight size={13} />
                                  </div>
                                  <div className="flex-1 min-w-0 text-right">
                                    <PersonBadge person={r.to_user_info} compact />
                                  </div>
                                </>
                              )}
                            </div>
                            {/* Notesheet content — same prose rendering as the Initial Notesheet card */}
                            <div>
                              <p className="text-xs font-semibold text-gray-400 uppercase mb-1">Notesheet</p>
                              <div className={cn("bg-gray-50 border border-gray-200 rounded-xl px-4 py-3", NOTESHEET_PROSE_CLASS)}
                                dangerouslySetInnerHTML={{ __html: toSafeNotesheetHtml(r.remark) }} />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* RIGHT: Edit Draft (creator, within window) / recipient-only picker
                  (draft, window closed) / Forward panel (subsequent holders) */}
              <div className="lg:col-span-1 space-y-5">
                {editingDraft ? (
                  <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 space-y-4">
                    <div className="flex items-center justify-between">
                      <h2 className="text-base font-bold text-gray-800">Edit Draft</h2>
                      <span className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">30-min window</span>
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-1.5">Subject</label>
                      <input value={draftSubject} onChange={(e) => setDraftSubject(e.target.value)}
                        className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]" />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-1.5">Department</label>
                      <select value={draftDepartmentId} onChange={(e) => setDraftDepartmentId(e.target.value)}
                        className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]">
                        <option value="">None</option>
                        {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-1.5">Category</label>
                      <select value={draftCategory} onChange={(e) => setDraftCategory(e.target.value)}
                        className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]">
                        {categories.filter((c) => c.is_active !== false).map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-1.5">Priority</label>
                      <select value={draftPriority} onChange={(e) => setDraftPriority(e.target.value)}
                        className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]">
                        {priorities.filter((p) => p.is_active !== false).map((p) => <option key={p.id} value={p.name}>{p.label ?? p.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-1.5">Recipient</label>
                      <SearchableSelect
                        groups={buildGroups(users, (u) => u.full_name + (u.designation ? ` — ${u.designation}` : ""))}
                        value={draftRecipientId}
                        onChange={setDraftRecipientId}
                        isFavorite={(id) => !!users.find((u) => u.id === id)?.is_favorite}
                        onToggleFavorite={(id) => {
                          const u = users.find((u) => u.id === id);
                          if (u) toggleFavorite(id, !!u.is_favorite);
                        }}
                        placeholder="No recipient yet…"
                        searchPlaceholder="Search users…"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-1.5">Notesheet</label>
                      <div className="border border-gray-200 rounded-xl overflow-hidden">
                        <RichTextToolbar editor={draftEditor} />
                        <EditorContent editor={draftEditor} className="min-h-[160px] text-sm" />
                      </div>
                    </div>
                    <div className="flex gap-2 pt-1">
                      <button onClick={() => setEditingDraft(false)}
                        className="flex-1 py-2.5 text-sm border border-gray-200 rounded-xl hover:bg-gray-50 font-medium">Cancel</button>
                      <button onClick={handleSaveDraft} disabled={updateFileMutation.isPending || updateNotesheetMutation.isPending}
                        className="flex-1 py-2.5 text-sm rounded-xl font-bold flex items-center justify-center gap-2 bg-[#0D6E6E] text-white hover:bg-[#178F8F] disabled:opacity-50">
                        {(updateFileMutation.isPending || updateNotesheetMutation.isPending) ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                        Save
                      </button>
                    </div>
                  </div>
                ) : needsRecipientPicker ? (
                  <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 space-y-4">
                    <div className="flex items-center justify-between">
                      <h2 className="text-base font-bold text-gray-800">Select Recipient</h2>
                      <span className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-full px-2 py-0.5">Editing locked</span>
                    </div>
                    <p className="text-sm text-gray-500">
                      The 30-minute editing window has closed, so the subject, category, priority and notesheet
                      are now read-only. You can still choose who to forward this file to.
                    </p>
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-1.5">Forward To *</label>
                      {users.length === 0 ? (
                        <p className="text-sm text-amber-600 bg-amber-50 rounded-xl p-3">No users available.</p>
                      ) : (
                        <SearchableSelect
                          groups={buildGroups(users, (u) => u.full_name + (u.designation ? ` — ${u.designation}` : "") + (u.department_name ? ` (${u.department_name})` : ""))}
                          value={toUserId}
                          onChange={setToUserId}
                          isFavorite={(id) => !!users.find((u) => u.id === id)?.is_favorite}
                          onToggleFavorite={(id) => {
                            const u = users.find((u) => u.id === id);
                            if (u) toggleFavorite(id, !!u.is_favorite);
                          }}
                          placeholder="Select…"
                          searchPlaceholder="Search users…"
                        />
                      )}
                    </div>
                    <button onClick={async () => {
                      if (!toUserId) { toast.warning("Please select a recipient to forward to."); return; }
                      const selected = users.find((u) => u.id === toUserId);
                      const confirmed = await confirmAction({
                        title: "Forward File",
                        html: `Are you sure you want to forward this file to <strong>${escapeHtml(selected?.full_name ?? "the selected recipient")}</strong>?`,
                        confirmText: "Forward",
                      });
                      if (confirmed) handleFirstForward(toUserId);
                    }} disabled={submitAction.isPending}
                      className="w-full py-2.5 text-sm rounded-xl font-bold flex items-center justify-center gap-2 bg-[#0D6E6E] text-white hover:bg-[#178F8F] disabled:opacity-50">
                      {submitAction.isPending ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
                      Forward
                    </button>
                  </div>
                ) : canForwardAfter ? (
                  <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 space-y-4">
                    <h2 className="text-base font-bold text-gray-800">Forward This File</h2>
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-1.5">Forward To *</label>
                      {users.length === 0 ? (
                        <p className="text-sm text-amber-600 bg-amber-50 rounded-xl p-3">No users available.</p>
                      ) : (
                        <SearchableSelect
                          groups={buildGroups(users, (u) => u.full_name + (u.designation ? ` — ${u.designation}` : "") + (u.department_name ? ` (${u.department_name})` : ""))}
                          value={toUserId}
                          onChange={setToUserId}
                          isFavorite={(id) => !!users.find((u) => u.id === id)?.is_favorite}
                          onToggleFavorite={(id) => {
                            const u = users.find((u) => u.id === id);
                            if (u) toggleFavorite(id, !!u.is_favorite);
                          }}
                          placeholder="Select…"
                          searchPlaceholder="Search users…"
                        />
                      )}
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-1.5">Notesheet</label>
                      <div className="border border-gray-200 rounded-xl overflow-hidden">
                        <RichTextToolbar editor={forwardEditor} />
                        <EditorContent editor={forwardEditor} className="min-h-[160px] text-sm" />
                      </div>
                    </div>
                    <div>
                      <label className="flex items-center gap-2 cursor-pointer w-full border-2 border-dashed border-gray-200 hover:border-[#0D6E6E] rounded-xl px-3 py-2.5 text-sm text-gray-500 hover:text-[#0D6E6E] transition-colors">
                        <Upload size={14} />
                        <span>Attach document (optional)…</span>
                        <input type="file" multiple accept={ALLOWED_ATTACHMENT_ACCEPT} className="sr-only" onChange={async (e) => {
                          const files = e.target.files;
                          e.target.value = "";
                          const count = await forwardAttachments.uploadNow(fileId, files);
                          if (count > 0) {
                            toast.success(`${count} file${count > 1 ? "s" : ""} uploaded.`);
                            qc.invalidateQueries({ queryKey: ["efms-file", fileId] });
                          }
                        }} />
                      </label>
                      {/* Uploaded files persist immediately (not just on Forward) and
                          appear in the "Attached Files" panel on the left — reusing
                          that existing list instead of a second, parallel one here. */}
                      <p className="text-xs text-gray-400 mt-1.5">Uploaded files appear in Attached Files on the left.</p>
                    </div>
                    <button onClick={handleSubmitAction} disabled={submitAction.isPending}
                      className="w-full py-2.5 text-sm rounded-xl font-bold flex items-center justify-center gap-2 bg-[#0D6E6E] text-white hover:bg-[#178F8F] disabled:opacity-50">
                      {submitAction.isPending ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
                      Forward
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          )}

          {activeTab === "track" && (
            <div className="p-6">
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm">
                <div className="px-6 py-4 border-b border-gray-100">
                  <h2 className="text-lg font-bold text-gray-800">File Tracking</h2>
                  <p className="text-sm text-gray-500 mt-0.5">Forwarding history — who sent to whom</p>
                </div>
                <div className="px-6 py-5">
                  {trackEntries.length === 0 ? (
                    <p className="text-base text-gray-400 text-center py-8">No routing events yet.</p>
                  ) : (
                    <div className="space-y-0">
                      {trackEntries.map((entry, i) => (
                        <div key={entry.id} className="flex items-start gap-4">
                          <div className="flex flex-col items-center">
                            <div className={cn("w-10 h-10 rounded-full flex items-center justify-center shrink-0 border-2",
                              entry.type === "sign" ? "bg-emerald-600 border-emerald-600" : "bg-[#0D6E6E] border-[#0D6E6E]")}>
                              {entry.type === "sign" ? <PenLine size={16} className="text-white" /> : <ArrowRight size={16} className="text-white" />}
                            </div>
                            {i < trackEntries.length - 1 && <div className="w-0.5 h-10 mt-1 bg-gray-200" />}
                          </div>
                          <div className="flex-1 pb-6">
                            <div className="flex items-center justify-between gap-3">
                              <p className="text-base font-bold text-gray-900 capitalize">
                                {entry.type === "sign" ? "Document Signed" : entry.action.replace("_"," ")}
                              </p>
                              {entry.created_at && (
                                <span className="text-xs text-gray-400 shrink-0">{formatDate(entry.created_at, "datetime")}</span>
                              )}
                            </div>
                            {entry.type === "sign" ? (
                              <>
                                <PersonBadge person={entry.from_user_info} fallback="System" className="mt-1" />
                                {entry.remarks && <p className="text-sm text-gray-600 mt-1">{entry.remarks}</p>}
                              </>
                            ) : (
                              <>
                                <div className="flex flex-col gap-1.5 mt-2 text-sm">
                                  <PersonBadge person={entry.from_user_info} fallback="System" />
                                  {entry.to_user_info && (
                                    <>
                                      <ArrowRight size={13} className="text-gray-400 rotate-90 shrink-0" />
                                      <PersonBadge person={entry.to_user_info} />
                                    </>
                                  )}
                                </div>
                                {entry.remarks && <p className="text-sm text-gray-500 mt-2 italic">&ldquo;{entry.remarks}&rdquo;</p>}
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── SIGN DOCUMENT TAB ── */}
          {activeTab === "sign" && (
            <div className="p-6 space-y-5">
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                      <PenLine size={18} className="text-emerald-600" /> Digital Signature
                    </h2>
                    <p className="text-sm text-gray-500 mt-0.5">
                      Click anywhere on the document to place your signature stamp, then confirm with OTP.
                    </p>
                  </div>
                  {pendingStamp && !showOtpModal && (
                    <button
                      onClick={async () => {
                        if (!pendingStamp) return;
                        try {
                          setOtpLoading(true);
                          const res = await api.post(`/efms/files/${fileId}/sign`, {
                            pos_x: pendingStamp.pos_x,
                            pos_y: pendingStamp.pos_y,
                            page_number: 1,
                          });
                          setPendingSignatureId(res.data.signature_id);
                          setShowOtpModal(true);
                          setOtpError(null);
                        } catch (err) {
                          const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
                          toast.error(msg ?? "Failed to initiate signature.");
                        } finally {
                          setOtpLoading(false);
                        }
                      }}
                      disabled={otpLoading}
                      className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-xl text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {otpLoading ? <Loader2 size={14} className="animate-spin" /> : <PenLine size={14} />}
                      Confirm Position &amp; Send OTP
                    </button>
                  )}
                </div>

                {/* Document canvas with overlay */}
                <div className="p-4">
                  {(() => {
                    const signTarget = selectedPdf ?? file.attachments[0];

                    if (!signTarget) {
                      return (
                        <div className="text-center py-16 text-gray-400">
                          <FileText size={40} className="mx-auto mb-3 opacity-40" />
                          <p>No attachments found. Attach a document to this file first.</p>
                        </div>
                      );
                    }

                    return (
                      <PdfSignatureCanvas
                        fileUrl={`${FILES_BASE_URL}/uploads/${signTarget.stored_name}`}
                        mimeType={signTarget.mime_type}
                        existingSignatures={(file.signatures ?? []).map((s) => ({ ...s, status: s.status as "pending" | "verified", verified_at: s.verified_at ?? undefined }))}
                        onPlace={(pos_x, pos_y) => {
                          setPendingStamp({ pos_x, pos_y });
                          setShowOtpModal(false);
                          setPendingSignatureId(null);
                        }}
                        pendingStamp={pendingStamp}
                        onClearPending={() => { setPendingStamp(null); setPendingSignatureId(null); }}
                      />
                    );
                  })()}
                </div>

                {/* Existing signatures list */}
                {(file.signatures ?? []).length > 0 && (
                  <div className="px-6 pb-5">
                    <h3 className="text-sm font-semibold text-gray-700 mb-3">Signature Log</h3>
                    <div className="space-y-2">
                      {(file.signatures ?? []).map((sig) => (
                        <div key={sig.id} className={cn(
                          "flex items-center gap-3 px-4 py-3 rounded-xl border text-sm",
                          sig.status === "verified"
                            ? "bg-emerald-50 border-emerald-200"
                            : "bg-amber-50 border-amber-200 border-dashed"
                        )}>
                          {sig.status === "verified"
                            ? <CheckCircle2 size={16} className="text-emerald-500 shrink-0" />
                            : <Lock size={16} className="text-amber-500 shrink-0" />
                          }
                          <div className="flex-1 flex items-center gap-2 flex-wrap">
                            <PersonBadge person={sig.signer_info} fallback={sig.signer_name || "Unknown"} compact />
                            <span className="text-gray-500">· Page {sig.page_number}, {sig.pos_x.toFixed(0)}% × {sig.pos_y.toFixed(0)}%</span>
                          </div>
                          <span className={cn("px-2 py-0.5 rounded-full text-xs font-semibold",
                            sig.status === "verified" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700")}>
                            {sig.status === "verified" ? "✓ Verified" : "? Pending"}
                          </span>
                          <span className="text-xs text-gray-400">
                            {formatDate(sig.verified_at ?? sig.signed_at ?? "", "datetime")}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* OTP Verification Modal */}
      {showOtpModal && pendingSignatureId && user && (
        <OtpVerifyModal
          email={user.email}
          fileRef={file.ref_number}
          isLoading={otpLoading}
          error={otpError}
          onClose={() => {
            setShowOtpModal(false);
            setOtpError(null);
          }}
          onVerify={async (otp) => {
            setOtpLoading(true);
            setOtpError(null);
            try {
              await api.post(`/efms/files/${fileId}/sign/${pendingSignatureId}/verify`, { otp_code: otp });
              showSuccess("Signature verified!");
              setShowOtpModal(false);
              setPendingStamp(null);
              setPendingSignatureId(null);
              qc.invalidateQueries({ queryKey: ["efms-file", fileId] });
              qc.invalidateQueries({ queryKey: ["file-track", fileId] });
            } catch (err) {
              const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
              setOtpError(msg ?? "Invalid OTP. Please try again.");
            } finally {
              setOtpLoading(false);
            }
          }}
        />
      )}

    </div>
  );
}
