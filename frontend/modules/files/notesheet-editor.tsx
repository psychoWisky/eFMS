"use client";
// File detail view: left panel = PDF attachments, main = Notesheet (creator's + each holder's own) + forwarding + track status
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, FILES_BASE_URL, API_URL } from "@/services/api";
import { toast } from "sonner";
import { confirmAction, showSuccess, escapeHtml } from "@/lib/alert";
import { useUser, useActiveRole } from "@/stores/auth.store";
import { cn, formatDate, getAttachmentPreviewKind } from "@/lib/utils";
import {
  ChevronLeft, FileText, Download, ArrowRight,
  Loader2, Lock, Clock, MessageSquare, Upload, X, PenLine,
  CheckCircle2, XCircle, Trash2, Pencil, Save, FileX2,
} from "lucide-react";
import PdfSignatureCanvas, { type SignatureStamp } from "@/components/signature/pdf-signature-canvas";
import OtpVerifyModal from "@/components/signature/otp-verify-modal";
import { PersonBadge, type PersonInfo } from "@/components/shared/person-badge";
import { FileClassificationBadge, FileClassificationBanner } from "@/components/shared/file-classification-badge";
import { SearchableSelect } from "@/components/shared/searchable-select";
import { useRichTextEditor, RichTextToolbar } from "@/components/shared/rich-text-editor";
import { EditorContent } from "@tiptap/react";
import { useFavoriteRecipients } from "@/hooks/use-favorite-recipients";
import { useRecipientFilter } from "@/hooks/use-recipient-filter";
import { OfficeSectionFilter } from "@/components/shared/office-section-filter";
import { useAttachmentQueue } from "@/hooks/use-attachment-queue";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";
import { ATTACHMENT_TAGS, CUSTOM_TAG_VALUE, ALLOWED_ATTACHMENT_ACCEPT, getFileExtension } from "@/lib/attachment-constants";
import { AttachmentPreviewModal } from "@/components/shared/attachment-preview-modal";
import { toSafeNotesheetHtml, NOTESHEET_PROSE_CLASS } from "@/lib/notesheet-html";

const DRAFT_EDIT_WINDOW_MS = 30 * 60 * 1000;
const ATTACHMENT_DELETE_WINDOW_MS = 5 * 60 * 1000;

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
// A holder's OWN Notesheet for this file — distinct from `Notesheet` above
// (the creator's single, shared document). This is the ONE user-facing note
// editor for the current holder; RouteEntry.remarks is an internal/audit
// field, never a second editor. One row per (file, user); writable only
// while that user is current_holder_id, permanently read-only afterward but
// still visible here as their historical contribution.
interface HolderNotesheet { id: string; file_id: string; user_id: string; content: string; created_at: string; updated_at: string; user_info?: PersonInfo | null; }
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
  // First-forward (Draft -> Active): confirmation-only, no recipient re-entry.
  // Subsequent forwards: inline recipient + attachments panel (no modal).
  // There is deliberately no separate remarks/notesheet text field here — the
  // current holder's Notesheet (My Notesheet, HolderNote-backed) IS their
  // remark; see handleSubmitAction below for how it's carried into the
  // RouteEntry created on Forward.
  const [toUserId, setToUserId] = useState("");
  const forwardAttachments = useAttachmentQueue();
  // True while saveForwardAttachments() is in flight — same manual
  // loading flag New File creation doesn't need (its upload only ever
  // happens once, at final submit) but this panel's Upload button does,
  // since it can be clicked repeatedly as more files are queued.
  const [uploadingQueue, setUploadingQueue] = useState(false);
  const { toggleFavorite, buildGroups } = useFavoriteRecipients();
  // Draft editing (30-minute window)
  const [editingDraft, setEditingDraft] = useState(false);
  const [draftSubject, setDraftSubject] = useState("");
  const [draftDepartmentId, setDraftDepartmentId] = useState("");
  const [draftCategory, setDraftCategory] = useState("");
  const [draftPriority, setDraftPriority] = useState("");
  const [draftRecipientId, setDraftRecipientId] = useState("");
  const [draftNotesheet, setDraftNotesheet] = useState("");
  // Snapshot of the Edit Draft fields as they were when editing began —
  // dirty state compares live values against this, never a hardcoded true.
  const [draftBaseline, setDraftBaseline] = useState<{
    subject: string; departmentId: string; category: string; priority: string; recipientId: string; notesheet: string;
  } | null>(null);
  // The current holder's OWN Notesheet (HolderNote.content) — server-
  // persisted, independent of the creator's Notesheet.content and of
  // RouteEntry.remarks (an internal/audit field only — never a second
  // user-facing editor; see handleSubmitAction for how this content is
  // carried into it on Forward). Baseline = last value returned/saved by
  // the backend; typing changes myNoteContent only, so dirty = content !== baseline.
  const [myNoteContent, setMyNoteContent] = useState("");
  const [myNoteBaseline, setMyNoteBaseline] = useState("");
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
  const [downloadingNotesheet, setDownloadingNotesheet] = useState(false);
  const [selectedPdf, setSelectedPdf] = useState<Attachment | null>(null);
  // Attachment Preview modal (docx/doc/xls/xlsx/csv) — native pdf/image/text
  // attachments still open directly via the /view endpoint, unchanged.
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);

  const { data: file, isLoading, isError } = useQuery<EfmsFile>({
    queryKey: ["efms-file", fileId],
    queryFn: async () => (await api.get(`/efms/files/${fileId}`)).data,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  // Every holder's OWN Notesheet for this file, oldest first — the correct,
  // HolderNote-backed replacement for what used to be shown here as
  // RouteEntry.remarks under a "Notesheet" label. Visible to anyone who can
  // open the file at all (same access boundary the file query itself uses).
  const { data: holderNotesheets = [] } = useQuery<HolderNotesheet[]>({
    queryKey: ["holder-notesheets", fileId],
    queryFn: async () => (await api.get(`/efms/files/${fileId}/holder-notesheets`)).data,
    enabled: !!file,
  });

  // The AUTHENTICATED user's own HolderNote — only ever fetched while they
  // are the file's current holder on an Active file (canEditHolderNotesheet,
  // derived below from the same file/user data). `null` means they haven't
  // saved one yet; the editor starts empty in that case, never pre-filled
  // from the creator's Notesheet or anyone else's HolderNote.
  const canEditHolderNotesheet = !!file && file.current_holder_id === user?.id && file.status === "active";
  const { data: myHolderNote, isSuccess: myHolderNoteLoaded } = useQuery<HolderNotesheet | null>({
    queryKey: ["holder-notesheet", fileId, user?.id],
    queryFn: async () => (await api.get(`/efms/files/${fileId}/holder-notesheet`)).data,
    enabled: canEditHolderNotesheet,
  });

  const { data: trackEntries = [] } = useQuery<TrackEntry[]>({
    queryKey: ["file-track", fileId],
    queryFn: async () => (await api.get(`/efms/files/${fileId}/track`)).data,
    enabled: activeTab === "track",
  });

  // Office/Section -> Recipient cascade — same shared hook/filtering logic as
  // New File creation, so recipient selection on an existing/received file
  // (Edit Draft, the post-window recipient picker, and Forward) behaves
  // identically instead of only ever seeing the unfiltered user list.
  const { officeId, setOfficeId, sectionId, setSectionId, offices, sections, users, loadingUsers } = useRecipientFilter();

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
  // This is deliberately NOT the same "Forward This File" panel used below
  // for subsequent forwards: My Notesheet only ever appears for an Active
  // file (canEditHolderNotesheet), never during Draft, so no document
  // editing is exposed here regardless — this comment documents why the two
  // panels are kept structurally separate rather than merged.
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
    mutationFn: (data: { action: string; remarks?: string; to_user_id?: string | null }) =>
      api.post(`/efms/files/${fileId}/route`, data),
  });

  async function afterForwardSuccess() {
    showSuccess("File forwarded.");
    setToUserId("");
    qc.invalidateQueries({ queryKey: ["efms-file", fileId] });
    qc.invalidateQueries({ queryKey: ["efms-files"] });
    qc.invalidateQueries({ queryKey: ["efms-files-outbox"] });
    qc.invalidateQueries({ queryKey: ["my-docket"] });
    qc.invalidateQueries({ queryKey: ["docket-released-mine"] });
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
      // No remarks field exists at first-forward — omitted (not "") so the
      // backend/timeline never mistake "nothing was ever written" for
      // "content exists but you can't see it."
      await submitAction.mutateAsync({ action: actionType, to_user_id: target });
      await afterForwardSuccess();
    } catch (err) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(msg ?? "Action failed.");
    }
  }

  // Subsequent forwards: recipient chosen inline in the panel; the current
  // holder's own Notesheet (My Notesheet) IS their remark for this forward —
  // there is no separate remarks field to fill in. Attachments are no longer
  // submitted here — the Forward panel's own "Upload N files" button
  // (saveForwardAttachments, below) already persisted them, with whatever
  // filename/tag the user chose, before this runs. Confirmed via the shared
  // confirmAction() (lib/alert.ts) before the API call actually runs — same
  // pattern as every other forward/delete action.
  async function handleSubmitAction() {
    if (!toUserId) { toast.warning("Please select a person to forward to."); return; }
    const selected = users.find((u) => u.id === toUserId);
    const confirmed = await confirmAction({
      title: "Forward File",
      html: `Are you sure you want to forward this file to <strong>${escapeHtml(selected?.full_name ?? "the selected recipient")}</strong>?`,
      confirmText: "Forward",
    });
    if (!confirmed) return;
    // The Notesheet must never be silently lost on Forward: if it's dirty,
    // save it first (the PATCH also becomes this holder's permanent
    // historical record) and only proceed if that save actually succeeds.
    // If it's already clean, use the last-saved content directly — no
    // redundant save call.
    let noteContent = myNoteBaseline;
    if (myNoteDirty) {
      const saved = await saveMyNotesheet();
      if (saved === null) return; // save failed — stay on the page, error already shown, still dirty
      noteContent = saved;
    }
    try {
      // Omit (not "") when the holder never wrote anything — same reasoning
      // as handleFirstForward above.
      await submitAction.mutateAsync({ action: actionType, remarks: noteContent || undefined, to_user_id: toUserId || null });
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

  // The current holder's own Notesheet — a dedicated (file, user) row, never
  // the shared Notesheet.content above. Backend enforces current_holder_id
  // == caller on every write, so this rejects on its own the moment the
  // file is forwarded away from them — no client-side check is load-bearing.
  const saveHolderNotesheetMutation = useMutation({
    mutationFn: (content: string) =>
      api.patch<HolderNotesheet>(`/efms/files/${fileId}/holder-notesheet`, { content }),
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

  // Notesheet download must go through the shared `api` client (not a plain
  // <a href>) so its Authorization-header interceptor actually runs — the
  // backend endpoint requires a real Bearer token (get_current_verified_user
  // + _assert_file_access), unlike the attachment view/download endpoints,
  // which are deliberately unauthenticated. Fetched as a blob and downloaded
  // client-side instead of navigating the browser to the API URL directly.
  async function handleDownloadNotesheet() {
    if (!file) return;
    setDownloadingNotesheet(true);
    try {
      const res = await api.get(`/efms/files/${fileId}/notesheet/download`, { responseType: "blob" });
      const blobUrl = URL.createObjectURL(res.data as Blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = `${file.ref_number.replace(/\//g, "-")}-notesheet.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      // With responseType "blob", an error response body also arrives as a
      // Blob (axios doesn't auto-parse it as JSON) — read/parse it manually
      // to surface the backend's actual {"detail": "..."} message.
      let msg = "Could not download the notesheet.";
      const errBlob = (err as { response?: { data?: unknown } })?.response?.data;
      if (errBlob instanceof Blob) {
        try {
          const parsed = JSON.parse(await errBlob.text());
          if (typeof parsed?.detail === "string") msg = parsed.detail;
        } catch { /* not JSON — keep the generic message */ }
      }
      toast.error(msg);
    } finally {
      setDownloadingNotesheet(false);
    }
  }

  // Shared blob fetch for attachment view/download/zip — these endpoints now
  // require authentication + per-attachment authorization (previously they
  // were unauthenticated, relying only on the stored filename being an
  // unguessable UUID), so a plain <a href> can no longer be used: the
  // browser attaches no Authorization header to a bare navigation. Mirrors
  // handleDownloadNotesheet's existing blob-fetch-then-synthetic-click
  // pattern above; `errorFallback` lets each caller phrase its own default
  // message while sharing the same axios/Blob error-body parsing.
  async function fetchAttachmentBlob(url: string, errorFallback: string): Promise<Blob | null> {
    try {
      const res = await api.get(url, { responseType: "blob" });
      return res.data as Blob;
    } catch (err) {
      let msg = errorFallback;
      const errBlob = (err as { response?: { data?: unknown } })?.response?.data;
      if (errBlob instanceof Blob) {
        try {
          const parsed = JSON.parse(await errBlob.text());
          if (typeof parsed?.detail === "string") msg = parsed.detail;
        } catch { /* not JSON — keep the generic message */ }
      }
      toast.error(msg);
      return null;
    }
  }

  async function viewAttachment(attId: string) {
    const blob = await fetchAttachmentBlob(`/efms/files/${fileId}/attachments/${attId}/view`, "Could not open this attachment.");
    if (!blob) return;
    const blobUrl = URL.createObjectURL(blob);
    // Deliberately not revoked immediately — the new tab needs the blob URL
    // to remain valid while it renders. Left to the browser's own tab/blob
    // lifecycle, same tradeoff the previous unauthenticated direct-link
    // approach had no control over either.
    window.open(blobUrl, "_blank", "noopener,noreferrer");
  }

  async function downloadAttachment(attId: string, filename: string) {
    const blob = await fetchAttachmentBlob(`/efms/files/${fileId}/attachments/${attId}/download`, "Could not download this attachment.");
    if (!blob) return;
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(blobUrl);
  }

  async function downloadAllAttachmentsZip() {
    if (!file) return;
    const blob = await fetchAttachmentBlob(`/efms/files/${fileId}/attachments/zip`, "Could not download attachments.");
    if (!blob) return;
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = `${file.ref_number.replace(/\//g, "-")}-attachments.zip`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(blobUrl);
  }

  // Returns whether the save fully succeeded — callers (the plain Save
  // button, and the unsaved-changes guard) must never treat a partial
  // failure (metadata saved but notesheet failed) as success or navigate/
  // close on it.
  async function handleSaveDraft(): Promise<boolean> {
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
      return true;
    } catch (err) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(msg ?? "Could not save draft changes.");
      return false;
    }
  }

  function openEditDraft() {
    if (!file) return;
    const baseline = {
      subject: file.subject,
      departmentId: file.department_id ?? "",
      category: file.category,
      priority: file.priority,
      recipientId: file.recipient_id ?? "",
      notesheet: file.notesheet?.content ?? "",
    };
    setDraftSubject(baseline.subject);
    setDraftDepartmentId(baseline.departmentId);
    setDraftCategory(baseline.category);
    setDraftPriority(baseline.priority);
    setDraftRecipientId(baseline.recipientId);
    setDraftNotesheet(baseline.notesheet);
    setDraftBaseline(baseline);
    setEditingDraft(true);
  }

  // Discard = restore to the last-persisted version captured in
  // draftBaseline, never send the unsaved notesheet changes, and close the
  // panel — distinct from Cancel, which leaves the panel open with changes
  // intact (handled by the guard dialog itself, not this function).
  function discardEditDraft() {
    if (draftBaseline) {
      setDraftSubject(draftBaseline.subject);
      setDraftDepartmentId(draftBaseline.departmentId);
      setDraftCategory(draftBaseline.category);
      setDraftPriority(draftBaseline.priority);
      setDraftRecipientId(draftBaseline.recipientId);
      setDraftNotesheet(draftBaseline.notesheet);
    }
    setEditingDraft(false);
  }

  // Explicit "Save Changes" for the current holder's OWN Notesheet — the
  // real, server-persisted persistence boundary this feature needed, and
  // the ONLY user-facing note editor on this page. PATCHes HolderNote only:
  // never forwards, never creates a RouteEntry, never touches
  // current_holder_id/status, never touches the creator's Notesheet.content
  // or any other holder's HolderNote. Returns the saved content on success
  // (so handleSubmitAction can carry the authoritative just-saved value into
  // the Forward call without relying on a stale state closure) or null on
  // failure, so callers never treat a failure as success.
  async function saveMyNotesheet(): Promise<string | null> {
    try {
      const res = await saveHolderNotesheetMutation.mutateAsync(myNoteContent);
      setMyNoteBaseline(res.data.content);
      showSuccess("Changes saved.");
      // Both the singular (this holder's own note, keyed by user id) and
      // plural (Notesheet History, everyone's notes) caches must be
      // invalidated — the local myNoteBaseline update above already keeps
      // this render correct, but a stale singular cache entry would
      // otherwise linger for any other code path that reads it.
      qc.invalidateQueries({ queryKey: ["holder-notesheet", fileId, user?.id] });
      qc.invalidateQueries({ queryKey: ["holder-notesheets", fileId] });
      return res.data.content;
    } catch (err) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(msg ?? "Could not save your Notesheet.");
      return null;
    }
  }

  // Discard = restore both React state and the visible editor to the last
  // value the BACKEND returned — never localStorage, never another user's
  // content. myNoteEditor's `content` option is a stable constant (bound to
  // myNoteBaseline, which only changes on load/save, not on every
  // keystroke), so the visible document only changes via an explicit commands.setContent()
  // call; this is that call for the Leave path.
  function discardMyNotesheet() {
    myNoteEditor?.commands.setContent(myNoteBaseline);
    setMyNoteContent(myNoteBaseline);
  }

  // Unsaved locally-queued forward attachments only — already-uploaded ones
  // are not "unsaved" (the existing explicit Upload action already
  // persisted them). Deliberately excludes `remarks`/forwarding text: saving
  // changes here must never itself create a RouteEntry (that stays a
  // separate, explicit Forward action) per the product rule that "Save
  // Changes" must never imply "Forward the file."
  async function saveForwardAttachments(): Promise<boolean> {
    if (forwardAttachments.hasInvalidCustomTags()) {
      toast.error("Please enter a valid custom tag for every attachment marked \"Other\".");
      return false;
    }
    const total = forwardAttachments.items.length;
    const { succeeded, failed } = await forwardAttachments.uploadAllReporting(fileId);
    if (succeeded > 0) qc.invalidateQueries({ queryKey: ["efms-file", fileId] });
    if (failed.length > 0) {
      toast.error(`${failed.length} of ${total} attachment${total > 1 ? "s" : ""} failed to upload: ${failed.map((f) => f.name).join(", ")}. They remain queued — try again.`);
      return false;
    }
    toast.success(`${succeeded} file${succeeded > 1 ? "s" : ""} uploaded.`);
    return true;
  }

  function discardForwardAttachments() {
    forwardAttachments.clear();
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

  // `content` is bound to myNoteBaseline (changes only on load/save), NEVER
  // to myNoteContent (which changes on every keystroke) — that reactive
  // two-way binding is exactly what broke dirty tracking in an earlier
  // iteration of this feature: Tiptap v3's useEditor re-diffs `content`
  // against its stored options on every render, so a value that changes on
  // every keystroke churns in lockstep with typing instead of letting
  // onChange propagate cleanly. The imperative commands.setContent() below
  // is the only thing that ever pushes content into the editor after
  // creation — once when the backend GET resolves, and once on Discard.
  const myNoteEditor = useRichTextEditor({ content: myNoteBaseline, onChange: setMyNoteContent, editable: true });
  useEffect(() => {
    if (!myHolderNoteLoaded || !myNoteEditor) return;
    const content = myHolderNote?.content ?? "";
    setMyNoteContent(content);
    setMyNoteBaseline(content);
    if (myNoteEditor.getHTML() !== content) {
      myNoteEditor.commands.setContent(content);
    }
    // myNoteEditor must be a dependency: on a fresh mount the HolderNote GET
    // can resolve before Tiptap finishes creating the editor instance
    // (immediatelyRender:false means it's briefly null), so this effect can
    // fire once, no-op on the null-editor guard above, and — without
    // myNoteEditor in the deps — never get a chance to re-run once the
    // editor actually becomes available, leaving the loaded content
    // discarded. Including it lets the effect correctly fire again the
    // moment the editor is ready.
  }, [myHolderNoteLoaded, myHolderNote, myNoteEditor]);

  // Pre-fill the recipient-only picker (needsRecipientPicker) with whatever
  // recipient is already on the draft, if any — the user can still change it.
  useEffect(() => {
    if (needsRecipientPicker && file?.recipient_id && !toUserId) {
      setToUserId(file.recipient_id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsRecipientPicker, file?.recipient_id]);

  // If Office/Section narrows the recipient list to exclude whichever
  // recipient is currently selected, clear that selection rather than
  // silently keeping a hidden, filtered-out pick — same behavior as New
  // File creation's identical effect, kept consistent across both.
  useEffect(() => {
    if (!loadingUsers && draftRecipientId && !users.some((u) => u.id === draftRecipientId)) {
      setDraftRecipientId("");
    }
  }, [users, loadingUsers, draftRecipientId]);
  useEffect(() => {
    if (!loadingUsers && toUserId && !users.some((u) => u.id === toUserId)) {
      setToUserId("");
    }
  }, [users, loadingUsers, toUserId]);

  useEffect(() => {
    if (file?.attachments.length && !selectedPdf) setSelectedPdf(file.attachments[0]);
  }, [file]);

  // Real, actual-change-based dirty tracking for every independently-dirty
  // part of this page — never a hardcoded true. Edit Draft (creator, draft
  // file) and the current holder's own Notesheet (active file) are mutually
  // exclusive by file status, but the holder's Notesheet and queued Forward
  // attachments can both be dirty at once for the same active file, so both
  // are combined into one guard registration rather than two separate ones
  // (the store only ever holds a single active registration). The Initial
  // Notesheet and every other holder's Notesheet/history are never part of
  // this — they're immutable and read-only, with no editable state to track.
  const editDraftDirty = editingDraft && !!draftBaseline && (
    draftSubject !== draftBaseline.subject ||
    draftDepartmentId !== draftBaseline.departmentId ||
    draftCategory !== draftBaseline.category ||
    draftPriority !== draftBaseline.priority ||
    draftRecipientId !== draftBaseline.recipientId ||
    draftNotesheet !== draftBaseline.notesheet
  );
  const myNoteDirty = canEditHolderNotesheet && myNoteContent !== myNoteBaseline;
  // Already-uploaded attachments are never "unsaved" — only locally-queued,
  // not-yet-uploaded ones count, matching the existing immediate-upload
  // architecture (nothing here silently changes when attachments persist).
  const forwardAttachmentsDirty = canForwardAfter && forwardAttachments.items.length > 0;
  const pageIsDirty = editDraftDirty || myNoteDirty || forwardAttachmentsDirty;

  // The navigation guard's ONLY job is "if dirty, ask Leave/Stay" — it never
  // saves. Persisting each part only ever happens via that part's own
  // explicit "Save Changes" button (handleSaveDraft / saveMyNotesheet) or
  // the Forward panel's existing explicit "Upload N files" button
  // (saveForwardAttachments below remains available for that button, not for
  // the guard). Leave discards whichever local unsaved parts are dirty —
  // never touches already-persisted backend data, the creator's Notesheet,
  // or any other holder's HolderNote/history.
  function handleGuardDiscard() {
    if (editDraftDirty) discardEditDraft();
    if (myNoteDirty) discardMyNotesheet();
    if (forwardAttachmentsDirty) discardForwardAttachments();
  }

  const { guardNavigation } = useUnsavedChangesGuard({
    isDirty: pageIsDirty,
    onDiscard: handleGuardDiscard,
  });

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
          <button onClick={() => guardNavigation(() => router.back())} className="flex items-center gap-1 text-sm text-[#0D6E6E] hover:underline mb-3">
            <ChevronLeft size={14} /> Back
          </button>
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-bold text-gray-900">Attached Files</h2>
              <p className="text-xs text-gray-400 mt-0.5">PDF versions for download</p>
            </div>
            {file.attachments.length > 0 && (
              <button
                type="button"
                onClick={downloadAllAttachmentsZip}
                title="Download all attachments as a ZIP"
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-[#0D6E6E] border border-gray-200 rounded-lg px-2 py-1.5 shrink-0"
              >
                <Download size={12} /> All
              </button>
            )}
          </div>
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
                    {(() => {
                      const kind = getAttachmentPreviewKind(att);
                      if (kind === "native") {
                        return (
                          <button
                            type="button"
                            onClick={() => { setSelectedPdf(att); viewAttachment(att.id); }}
                            className="text-xs text-[#0D6E6E] font-semibold hover:underline"
                          >
                            View
                          </button>
                        );
                      }
                      if (kind === "none") {
                        return (
                          <span
                            title="Preview is not available for this file type. Please download the file to view it."
                            className="text-xs text-gray-400 cursor-default"
                          >
                            No preview
                          </span>
                        );
                      }
                      return (
                        <button
                          type="button"
                          onClick={() => { setSelectedPdf(att); setPreviewAttachment(att); }}
                          className="text-xs text-[#0D6E6E] font-semibold hover:underline"
                        >
                          View
                        </button>
                      );
                    })()}
                    <button
                      type="button"
                      onClick={() => downloadAttachment(att.id, att.original_name)}
                      className="text-xs text-gray-500 hover:text-gray-700 hover:underline"
                    >
                      Download
                    </button>
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
            <button type="button" onClick={() => downloadAttachment(selectedPdf.id, selectedPdf.original_name)}
              className="flex items-center justify-center gap-2 w-full py-2.5 bg-[#0D6E6E] text-white rounded-xl text-sm font-semibold hover:bg-[#178F8F]">
              <Download size={15} /> Download
            </button>
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
              {isHolder && file.notesheet && (
                <button
                  onClick={handleDownloadNotesheet}
                  disabled={downloadingNotesheet}
                  className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 text-gray-700 rounded-xl text-sm font-semibold hover:bg-gray-50 disabled:opacity-50"
                >
                  {downloadingNotesheet ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                  Download Notesheet
                </button>
              )}
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
                    {/* Immutable once created — the creator's initial notesheet
                        is permanent record, never editable by whoever
                        currently holds the file. The current holder's own
                        contribution has its own dedicated, editable "My
                        Notesheet" card further down this column (HolderNote-
                        backed) — never a PATCH to this one. */}
                    <span className="text-sm text-gray-400 flex items-center gap-1"><Lock size={13} /> Read-only</span>
                  </div>
                  {/* Creator/first-recipient context, same PersonBadge + layout
                      language as Notesheet History below. The actual first
                      forward (route_entries is ordered by created_at) is the
                      real "Forwarded to" answer once one exists; before that,
                      fall back to the informational recipient stored at
                      Draft creation, and omit this line entirely if neither
                      is available — never invent a movement that didn't happen. */}
                  {(file.creator_info || file.route_entries[0]?.to_user_info || file.recipient_info) && (
                    <div className="px-6 pt-5 flex flex-wrap items-start gap-x-8 gap-y-3">
                      {file.creator_info && (
                        <div className="flex items-start gap-1.5">
                          <span className="text-xs font-semibold text-gray-400 uppercase mt-0.5">Created by</span>
                          <PersonBadge person={file.creator_info} compact />
                        </div>
                      )}
                      {(file.route_entries[0]?.to_user_info ?? file.recipient_info) && (
                        <div className="flex items-start gap-1.5">
                          <span className="text-xs font-semibold text-gray-400 uppercase mt-0.5">Forwarded to</span>
                          <PersonBadge person={file.route_entries[0]?.to_user_info ?? file.recipient_info} compact />
                        </div>
                      )}
                    </div>
                  )}
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

                {/* Notesheet History — each PAST holder's OWN Notesheet
                    (HolderNote.content), oldest first. Deliberately backed
                    by GET /{fileId}/holder-notesheets, NOT RouteEntry.remarks
                    — this is the actual Notesheet content each holder wrote,
                    not their one-shot forwarding note. The viewer's own
                    still-editable row (if any) is shown separately in "My
                    Notesheet" below, not duplicated here. Every row here is
                    permanently read-only: no write path on this page ever
                    targets another user's HolderNote. */}
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm">
                  {(() => {
                    const historyNotes = holderNotesheets.filter((n) => !(canEditHolderNotesheet && n.user_id === user?.id));
                    return (
                      <>
                        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                          <div>
                            <h2 className="text-lg font-bold text-gray-800">Notesheet History</h2>
                            <p className="text-sm text-gray-500 mt-0.5">Each holder's own Notesheet, oldest first — read-only</p>
                          </div>
                          {historyNotes.length > 0 && (
                            <span className="text-xs font-semibold bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full">
                              {historyNotes.length} entr{historyNotes.length === 1 ? "y" : "ies"}
                            </span>
                          )}
                        </div>
                        {historyNotes.length === 0 ? (
                          <div className="px-6 py-10 text-center text-gray-400">
                            <p className="text-base">No previous holder Notesheets recorded yet.</p>
                          </div>
                        ) : (
                          <div className="px-6 py-5">
                            {historyNotes.map((n, idx, arr) => (
                              <div key={n.id} className="flex items-start gap-4">
                                {/* Numbered marker + connecting line — same timeline
                                    language as the Track Status tab's icon + line. */}
                                <div className="flex flex-col items-center">
                                  <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 border-2 bg-[#0D6E6E] border-[#0D6E6E]">
                                    <span className="text-xs font-bold text-white">{idx + 1}</span>
                                  </div>
                                  {idx < arr.length - 1 && <div className="w-0.5 flex-1 min-h-[24px] mt-1 bg-gray-200" />}
                                </div>
                                <div className="flex-1 min-w-0 pb-6">
                                  <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-1.5">
                                      <PersonBadge person={n.user_info} fallback="Unknown" compact />
                                      {n.user_id === user?.id && (
                                        <span className="text-xs text-[#0D6E6E] font-medium">(You)</span>
                                      )}
                                    </div>
                                    <span className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
                                      <Clock size={12} className="text-gray-400" />{formatDate(n.updated_at, "datetime")}
                                    </span>
                                  </div>
                                  {/* Notesheet content — same prose rendering as the Initial Notesheet card */}
                                  <div className={cn("bg-gray-50 border border-gray-200 rounded-xl px-4 py-3", NOTESHEET_PROSE_CLASS)}
                                    dangerouslySetInnerHTML={{ __html: toSafeNotesheetHtml(n.content) }} />
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>

                {/* My Notesheet — the current holder's OWN, server-persisted
                    Notesheet (HolderNote), only ever shown/editable while
                    they are the file's current holder on an Active file.
                    Never the creator's shared Notesheet.content, never any
                    other holder's HolderNote. This is the ONLY user-facing
                    note editor on this page — there is no separate
                    "Forwarding Remarks" field. RouteEntry.remarks remains an
                    internal/audit field on Forward, populated automatically
                    from this content (see handleSubmitAction) rather than
                    asked for separately. Saving here never forwards the file. */}
                {canEditHolderNotesheet && (
                  <div className="bg-white rounded-2xl border border-gray-200 shadow-sm">
                    <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                      <div>
                        <h2 className="text-lg font-bold text-gray-800">My Notesheet</h2>
                        <p className="text-sm text-gray-500 mt-0.5">Your own Notesheet while you hold this file.</p>
                      </div>
                      <span className="flex items-center gap-1.5 text-sm text-[#0D6E6E] font-semibold"><Pencil size={13} /> Editable</span>
                    </div>
                    <div className="px-6 py-5 space-y-3">
                      <div className="border border-gray-200 rounded-xl overflow-hidden">
                        <RichTextToolbar editor={myNoteEditor} />
                        <EditorContent editor={myNoteEditor} className="min-h-[200px] text-sm" />
                      </div>
                      <div className="flex justify-end">
                        <button type="button" onClick={saveMyNotesheet} disabled={saveHolderNotesheetMutation.isPending || !myNoteDirty}
                          className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-bold rounded-xl bg-[#0D6E6E] text-white hover:bg-[#178F8F] disabled:opacity-50 disabled:cursor-not-allowed">
                          {saveHolderNotesheetMutation.isPending ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                          {saveHolderNotesheetMutation.isPending ? "Saving…" : "Save Changes"}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
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
                    <OfficeSectionFilter
                      officeId={officeId}
                      sectionId={sectionId}
                      offices={offices}
                      sections={sections}
                      onOfficeChange={setOfficeId}
                      onSectionChange={setSectionId}
                    />
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
                      <button onClick={() => guardNavigation(() => setEditingDraft(false))}
                        className="flex-1 py-2.5 text-sm border border-gray-200 rounded-xl hover:bg-gray-50 font-medium">Cancel</button>
                      <button onClick={handleSaveDraft} disabled={updateFileMutation.isPending || updateNotesheetMutation.isPending || !editDraftDirty}
                        className="flex-1 py-2.5 text-sm rounded-xl font-bold flex items-center justify-center gap-2 bg-[#0D6E6E] text-white hover:bg-[#178F8F] disabled:opacity-50">
                        {(updateFileMutation.isPending || updateNotesheetMutation.isPending) ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                        {(updateFileMutation.isPending || updateNotesheetMutation.isPending) ? "Saving…" : "Save Changes"}
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
                    <OfficeSectionFilter
                      officeId={officeId}
                      sectionId={sectionId}
                      offices={offices}
                      sections={sections}
                      onOfficeChange={setOfficeId}
                      onSectionChange={setSectionId}
                    />
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
                    <OfficeSectionFilter
                      officeId={officeId}
                      sectionId={sectionId}
                      offices={offices}
                      sections={sections}
                      onOfficeChange={setOfficeId}
                      onSectionChange={setSectionId}
                    />
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
                    {/* No separate remarks/notesheet text field here on
                        purpose — the current holder's own Notesheet ("My
                        Notesheet" card, left column) IS their remark for
                        this forward. handleSubmitAction saves it first (if
                        dirty) and carries that exact content into the
                        RouteEntry created by Forward below. */}
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-1.5">Attachments</label>
                      <label className="flex items-center gap-2 cursor-pointer w-full border-2 border-dashed border-gray-200 hover:border-[#0D6E6E] rounded-xl px-3 py-2.5 text-sm text-gray-500 hover:text-[#0D6E6E] transition-colors">
                        <Upload size={14} />
                        <span>Attach document (optional)…</span>
                        <input type="file" multiple accept={ALLOWED_ATTACHMENT_ACCEPT} className="sr-only" onChange={(e) => {
                          forwardAttachments.addFiles(e.target.files, file.attachments.length);
                          e.target.value = "";
                        }} />
                      </label>
                      {/* Same editable filename/tag rows as New File creation
                          (reuses attachmentQueue.items/renameItem/setTag/setCustomTag)
                          instead of uploading immediately with an unchangeable
                          auto-generated name — the user can rename or re-tag each
                          file, including a custom tag, before it's actually sent. */}
                      {forwardAttachments.items.length > 0 && (
                        <div className="space-y-2 mt-3">
                          {forwardAttachments.items.map((ann, i) => (
                            <div key={i} className="flex items-center gap-2 p-2.5 bg-gray-50 rounded-xl border border-gray-100">
                              <FileText size={15} className="text-[#0D6E6E] shrink-0" />
                              <div className="flex-1 grid grid-cols-2 gap-2">
                                <div>
                                  <label className="block text-[11px] font-medium text-gray-500 mb-0.5">File Name</label>
                                  <input value={ann.name} onChange={(e) => forwardAttachments.renameItem(i, e.target.value)}
                                    className="w-full border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-[#0D6E6E]" />
                                </div>
                                <div>
                                  <label className="block text-[11px] font-medium text-gray-500 mb-0.5">Tag</label>
                                  <select value={ann.tag} onChange={(e) => forwardAttachments.setTag(i, e.target.value)}
                                    className="w-full border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-[#0D6E6E]">
                                    {ATTACHMENT_TAGS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                                  </select>
                                  {ann.tag === CUSTOM_TAG_VALUE && (
                                    <input
                                      value={ann.customTag ?? ""}
                                      onChange={(e) => forwardAttachments.setCustomTag(i, e.target.value)}
                                      placeholder="Enter custom tag…"
                                      maxLength={60}
                                      className="mt-1 w-full border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-[#0D6E6E]"
                                    />
                                  )}
                                </div>
                              </div>
                              <button type="button" onClick={() => forwardAttachments.removeItem(i)} className="text-red-400 hover:text-red-600 shrink-0"><X size={14} /></button>
                            </div>
                          ))}
                          <button type="button" disabled={uploadingQueue} onClick={async () => {
                            setUploadingQueue(true);
                            try {
                              await saveForwardAttachments();
                            } finally {
                              setUploadingQueue(false);
                            }
                          }}
                            className="w-full py-2 text-xs font-semibold rounded-lg bg-[#0D6E6E] text-white hover:bg-[#178F8F] disabled:opacity-50 flex items-center justify-center gap-1.5">
                            {uploadingQueue ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                            Upload {forwardAttachments.items.length} file{forwardAttachments.items.length > 1 ? "s" : ""}
                          </button>
                        </div>
                      )}
                      {/* Uploaded files appear in the "Attached Files" panel on
                          the left — reusing that existing list instead of a
                          second, parallel one here. */}
                      <p className="text-xs text-gray-400 mt-1.5">Uploaded files appear in Attached Files on the left.</p>
                    </div>
                    <button onClick={handleSubmitAction} disabled={submitAction.isPending || saveHolderNotesheetMutation.isPending}
                      className="w-full py-2.5 text-sm rounded-xl font-bold flex items-center justify-center gap-2 bg-[#0D6E6E] text-white hover:bg-[#178F8F] disabled:opacity-50">
                      {(submitAction.isPending || saveHolderNotesheetMutation.isPending) ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
                      {saveHolderNotesheetMutation.isPending ? "Saving Notesheet…" : "Forward"}
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
                            {/* Track Status is movement/status only — no remark/notesheet
                                content here (that belongs to Notesheet History /
                                GET /docket/remarks, a separate feature/data source). */}
                            {entry.type === "sign" ? (
                              <PersonBadge person={entry.from_user_info} fallback="System" className="mt-1" />
                            ) : (
                              <div className="flex flex-col gap-1.5 mt-2 text-sm">
                                <PersonBadge person={entry.from_user_info} fallback="System" />
                                {entry.to_user_info && (
                                  <>
                                    <ArrowRight size={13} className="text-gray-400 rotate-90 shrink-0" />
                                    <PersonBadge person={entry.to_user_info} />
                                  </>
                                )}
                              </div>
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
                    // signTarget is only ever assigned below, once we know the candidate
                    // is actually signable — an Excel/CSV attachment (via selectedPdf,
                    // set whenever the user clicked "View" on it, or via the
                    // file.attachments[0] default) must never reach PdfSignatureCanvas
                    // or become the signing target. Reuses the same classification
                    // (getAttachmentPreviewKind) as the attachment list and preview
                    // modal instead of a separate file-type check.
                    const signCandidate = selectedPdf ?? file.attachments[0];

                    if (!signCandidate) {
                      return (
                        <div className="text-center py-16 text-gray-400">
                          <FileText size={40} className="mx-auto mb-3 opacity-40" />
                          <p>No attachments found. Attach a document to this file first.</p>
                        </div>
                      );
                    }

                    if (getAttachmentPreviewKind(signCandidate) === "sheet") {
                      return (
                        <div className="text-center py-16 text-gray-400">
                          <FileX2 size={40} className="mx-auto mb-3 opacity-40" />
                          <p className="font-semibold text-gray-600">eSign is not available for Excel files.</p>
                          <p className="text-sm mt-1">eSign is currently supported only for PDF and Word documents.</p>
                        </div>
                      );
                    }

                    const signTarget = signCandidate;

                    // Legacy .doc: the canvas needs a real .docx to render (docx-preview
                    // can't parse legacy binary Word), so it's fed the on-the-fly
                    // preview-docx conversion instead of the raw stored file — same
                    // conversion workflow the Attachment Preview modal uses.
                    const isLegacyDoc = getFileExtension(signTarget.original_name) === "doc";
                    return (
                      <PdfSignatureCanvas
                        fileUrl={`${FILES_BASE_URL}/uploads/${signTarget.stored_name}`}
                        mimeType={signTarget.mime_type}
                        docPreviewUrl={isLegacyDoc ? `${API_URL}/efms/files/${fileId}/attachments/${signTarget.id}/preview-docx` : undefined}
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

      {previewAttachment && (
        <AttachmentPreviewModal
          fileId={fileId}
          attachment={previewAttachment}
          onClose={() => setPreviewAttachment(null)}
        />
      )}

    </div>
  );
}
