"use client";
// File detail view: left panel = PDF attachments, main = forwarding remarks thread + notesheet + track status
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { toast } from "sonner";
import { useUser, useActiveRole } from "@/stores/auth.store";
import { cn, formatDate } from "@/lib/utils";
import {
  ChevronLeft, FileText, Download, CheckCircle2, XCircle, ArrowRight,
  Loader2, AlertCircle, Lock, Clock, MessageSquare, RotateCcw, Upload, X,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface RouteEntry { id: string; from_user_id: string | null; to_user_id: string | null; action: string; remarks: string | null; is_current: boolean; created_at: string; }
interface TrackEntry { id: string; from_user_id: string | null; to_user_id: string | null; from_user_name: string | null; to_user_name: string | null; action: string; remarks: string | null; is_current: boolean; created_at: string; }
interface Attachment { id: string; original_name: string; file_size: number | null; mime_type: string | null; stored_name: string; created_at: string; }
interface Notesheet { id: string; content: string; version: number; is_locked: boolean; }
interface EfmsFile {
  id: string; ref_number: string; subject: string; category: string;
  status: string; priority: string; is_confidential: boolean;
  created_by: string; current_holder_id: string | null;
  recipient_name: string | null; created_at: string; updated_at: string;
  is_released: boolean;
  notesheet: Notesheet | null; route_entries: RouteEntry[]; attachments: Attachment[];
}
interface ForwardingRemark { id: string; remark: string; user_name: string; user_id: string; created_at: string; }
interface SystemUser { id: string; email: string; full_name: string; active_role: string | null; designation: string | null; }

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  draft:        { bg: "bg-gray-100",   text: "text-gray-700",  label: "Draft" },
  pending:      { bg: "bg-amber-100",  text: "text-amber-800", label: "Pending Review" },
  under_review: { bg: "bg-blue-100",   text: "text-blue-800",  label: "Under Review" },
  approved:     { bg: "bg-green-100",  text: "text-green-800", label: "Approved" },
  rejected:     { bg: "bg-red-100",    text: "text-red-800",   label: "Rejected" },
  dispatched:   { bg: "bg-teal-100",   text: "text-teal-800",  label: "Dispatched" },
};

function daysElapsed(d: string) { return Math.floor((Date.now() - new Date(d).getTime()) / 86400000); }

export function NotesheetPage({ fileId }: { fileId: string }) {
  const router = useRouter();
  const user = useUser();
  const role = useActiveRole();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<"notesheet" | "track">("notesheet");
  const [actionModal, setActionModal] = useState(false);
  const [actionType, setActionType] = useState<"forward" | "approve" | "reject" | "return">("forward");
  const [toUserId, setToUserId] = useState("");
  const [remarks, setRemarks] = useState("");
  const [selectedPdf, setSelectedPdf] = useState<Attachment | null>(null);
  const [modalFiles, setModalFiles] = useState<{ file: File; name: string; tag: string }[]>([]);

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

  const isHolder = file?.current_holder_id === user?.id;
  const isDraft = file?.status === "draft";
  const isTerminal = ["approved","rejected","dispatched"].includes(file?.status ?? "");
  const isReleased = file?.is_released ?? false;
  const canApproveReject = isHolder && !isDraft && !isTerminal && role && ["hod","registrar","efms_admin","efms_officer","admin","super_admin"].includes(role);
  const canForwardDraft = isHolder && isDraft;
  const canForwardAfter = isHolder && !isDraft;
  // Dept members can forward a released file (backend enforces same-dept check)
  const canForwardReleased = isReleased && !isHolder;

  const submitAction = useMutation({
    mutationFn: (data: { action: string; remarks: string; to_user_id?: string | null }) =>
      api.post(`/efms/files/${fileId}/route`, data),
  });

  async function handleSubmitAction() {
    if (actionType === "reject" && !remarks.trim()) { toast.warning("Please provide a rejection reason."); return; }
    if ((actionType === "forward" || actionType === "return") && !toUserId) { toast.warning("Please select a person."); return; }
    try {
      await submitAction.mutateAsync({ action: actionType, remarks, to_user_id: toUserId || null });
      // Upload any attachments added in this modal
      for (const mf of modalFiles) {
        const form = new FormData();
        form.append("upload", mf.file, `${mf.tag}-${mf.name || mf.file.name}`);
        await api.post(`/efms/files/${fileId}/attachments`, form, {
          headers: { "Content-Type": "multipart/form-data" },
        }).catch(() => {});
      }
      const label = actionType === "approve" ? "File approved." : actionType === "reject" ? "File rejected." : actionType === "return" ? "File returned." : "File forwarded.";
      toast.success(label);
      setActionModal(false); setRemarks(""); setToUserId(""); setModalFiles([]);
      qc.invalidateQueries({ queryKey: ["efms-file", fileId] });
      qc.invalidateQueries({ queryKey: ["efms-files"] });
      qc.invalidateQueries({ queryKey: ["efms-files-outbox"] });
      qc.invalidateQueries({ queryKey: ["my-docket"] });
      qc.invalidateQueries({ queryKey: ["docket-released"] });
      qc.invalidateQueries({ queryKey: ["notifications"] });
    } catch (err) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(msg ?? "Action failed.");
    }
  }

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

  const statusStyle = STATUS_STYLES[file.status] ?? STATUS_STYLES.draft;
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
            file.attachments.map((att) => (
              <button key={att.id} onClick={() => setSelectedPdf(att)}
                className={cn("w-full flex items-start gap-3 p-3 rounded-xl border text-left transition-all",
                  selectedPdf?.id === att.id ? "border-[#0D6E6E] bg-[#E6F4F4]" : "border-gray-100 hover:border-gray-200 bg-gray-50")}>
                <FileText size={18} className="text-[#0D6E6E] shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">{att.original_name}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{att.file_size ? `${(att.file_size/1024).toFixed(0)} KB · ` : ""}{formatDate(att.created_at, "relative")}</p>
                </div>
              </button>
            ))
          )}
        </div>
        {selectedPdf && (
          <div className="p-3 border-t border-gray-200">
            <a href={`http://localhost:8000/uploads/${selectedPdf.stored_name}`} target="_blank" rel="noreferrer"
              className="flex items-center justify-center gap-2 w-full py-2.5 bg-[#0D6E6E] text-white rounded-xl text-sm font-semibold hover:bg-[#178F8F]">
              <Download size={15} /> Download PDF
            </a>
          </div>
        )}
      </div>

      {/* Main panel */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* File header */}
        <div className="bg-white border-b border-gray-200 px-6 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="font-mono text-sm font-bold text-[#0D6E6E] bg-[#E6F4F4] px-2 py-0.5 rounded">{file.ref_number}</span>
                <span className={cn("px-2 py-0.5 rounded-full text-sm font-semibold", statusStyle.bg, statusStyle.text)}>{statusStyle.label}</span>
                {file.priority === "urgent" && <span className="flex items-center gap-1 text-sm text-red-600 font-bold"><AlertCircle size={13} /> URGENT</span>}
                <span className={cn("text-sm font-semibold px-2 py-0.5 rounded-full",
                  days > 7 ? "text-red-600 bg-red-50" : days > 3 ? "text-amber-600 bg-amber-50" : "text-green-600 bg-green-50")}>
                  {days}d elapsed
                </span>
              </div>
              <h1 className="text-xl font-bold text-gray-900 truncate">{file.subject}</h1>
              <p className="text-sm text-gray-500 mt-0.5">{file.category} · Created {formatDate(file.created_at, "relative")}{file.recipient_name ? ` · To: ${file.recipient_name}` : ""}</p>
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-2 shrink-0">
              {canForwardDraft && (
                <button onClick={() => { setActionType("forward"); setActionModal(true); }}
                  className="flex items-center gap-1.5 px-4 py-2 bg-[#0D6E6E] text-white rounded-xl text-sm font-semibold hover:bg-[#178F8F]">
                  <ArrowRight size={15} /> Forward to Recipient
                </button>
              )}
              {canApproveReject && (
                <>
                  <button onClick={() => { setActionType("return"); setActionModal(true); }}
                    className="flex items-center gap-1.5 px-3 py-2 bg-amber-50 text-amber-700 border border-amber-200 rounded-xl text-sm font-semibold hover:bg-amber-100">
                    <RotateCcw size={14} /> Return
                  </button>
                  <button onClick={() => { setActionType("reject"); setActionModal(true); }}
                    className="flex items-center gap-1.5 px-3 py-2 bg-red-50 text-red-600 border border-red-200 rounded-xl text-sm font-semibold hover:bg-red-100">
                    <XCircle size={14} /> Reject
                  </button>
                  <button onClick={() => { setActionType("approve"); setActionModal(true); }}
                    className="flex items-center gap-1.5 px-3 py-2 bg-green-600 text-white rounded-xl text-sm font-semibold hover:bg-green-700">
                    <CheckCircle2 size={14} /> Approve
                  </button>
                  <button onClick={() => { setActionType("forward"); setActionModal(true); }}
                    className="flex items-center gap-1.5 px-3 py-2 bg-[#0D6E6E] text-white rounded-xl text-sm font-semibold hover:bg-[#178F8F]">
                    <ArrowRight size={14} /> Forward
                  </button>
                </>
              )}
              {canForwardAfter && !canApproveReject && (
                <button onClick={() => { setActionType("forward"); setActionModal(true); }}
                  className="flex items-center gap-1.5 px-3 py-2 bg-[#0D6E6E] text-white rounded-xl text-sm font-semibold hover:bg-[#178F8F]">
                  <ArrowRight size={14} /> Forward
                </button>
              )}
              {canForwardReleased && (
                <button onClick={() => { setActionType("forward"); setActionModal(true); }}
                  className="flex items-center gap-1.5 px-3 py-2 bg-[#0D6E6E] text-white rounded-xl text-sm font-semibold hover:bg-[#178F8F]">
                  <ArrowRight size={14} /> Forward
                </button>
              )}
            </div>
          </div>

          {/* Status tracker bar */}
          <div className={cn("mt-3 rounded-xl px-4 py-3 flex items-center gap-3",
            file.status === "approved" ? "bg-green-50 border border-green-200" :
            file.status === "rejected" ? "bg-red-50 border border-red-200" :
            "bg-amber-50 border border-amber-200")}>
            <div className={cn("w-2 h-2 rounded-full shrink-0",
              file.status === "approved" ? "bg-green-500" : file.status === "rejected" ? "bg-red-500" : "bg-amber-500")} />
            <p className="text-base text-gray-700">
              {file.status === "draft"   ? "Draft — not yet forwarded. Use 'Forward to Recipient' when ready." :
               file.status === "pending" ? "Forwarded — awaiting review by the current holder." :
               file.status === "approved"? "This file has been approved." :
               file.status === "rejected"? "This file was rejected. See routing history for remarks." :
               file.status === "dispatched" ? "Officially dispatched." : "Under review."}
            </p>
            {!isHolder && <span className="ml-auto text-sm text-gray-400 shrink-0"><Lock size={13} className="inline mr-1" />Read-only</span>}
          </div>

          {/* Tabs */}
          <div className="flex gap-1 mt-3">
            {([{id:"notesheet",label:"Notesheet"},{id:"track",label:"Track Status"}] as const).map((t) => (
              <button key={t.id} onClick={() => setActiveTab(t.id)}
                className={cn("px-4 py-2 text-sm font-semibold rounded-lg transition-colors",
                  activeTab === t.id ? "bg-[#0D6E6E] text-white" : "text-gray-600 hover:bg-gray-100")}>
                {t.label === "Track Status" ? <><Clock size={13} className="inline mr-1" />Track Status</> : <><MessageSquare size={13} className="inline mr-1" />Notesheet &amp; Remarks</>}
              </button>
            ))}
          </div>
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === "notesheet" && (
            <div className="p-6 space-y-5">
              {/* Official Notesheet (read-only) */}
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm">
                <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                  <h2 className="text-lg font-bold text-gray-800">Official Notesheet</h2>
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

              {/* Forwarding remarks — professional document log */}
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm">
                <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-bold text-gray-800">Forwarding Remarks</h2>
                    <p className="text-sm text-gray-500 mt-0.5">Official remarks recorded during file movement</p>
                  </div>
                  {forwardingRemarks.filter((r) => r.remark).length > 0 && (
                    <span className="text-xs font-semibold bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full">
                      {forwardingRemarks.filter((r) => r.remark).length} entr{forwardingRemarks.filter((r) => r.remark).length === 1 ? "y" : "ies"}
                    </span>
                  )}
                </div>
                {forwardingRemarks.filter((r) => r.remark).length === 0 ? (
                  <div className="px-6 py-10 text-center text-gray-400">
                    <p className="text-base">No forwarding remarks recorded.</p>
                  </div>
                ) : (
                  <div className="divide-y divide-gray-100">
                    {forwardingRemarks.filter((r) => r.remark).map((r, idx, arr) => {
                      const dt = new Date(r.created_at);
                      const dateStr = dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
                      const timeStr = dt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
                      const initials = (r.user_name ?? "?").split(" ").map((w: string) => w[0]).slice(0, 2).join("").toUpperCase();
                      return (
                        <div key={r.id} className="px-6 py-5">
                          <div className="flex items-start gap-4">
                            {/* Serial number */}
                            <div className="w-7 h-7 rounded-full bg-gray-100 border border-gray-200 flex items-center justify-center shrink-0 mt-0.5">
                              <span className="text-xs font-bold text-gray-500">{arr.length - idx}</span>
                            </div>
                            <div className="flex-1 min-w-0">
                              {/* Header row */}
                              <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
                                <div className="flex items-center gap-2.5">
                                  <div className="w-8 h-8 rounded-full bg-[#0D6E6E] flex items-center justify-center text-white text-xs font-bold shrink-0">
                                    {initials}
                                  </div>
                                  <div>
                                    <p className="text-sm font-semibold text-gray-900 leading-tight">{r.user_name ?? "Unknown"}</p>
                                    {r.user_id === user?.id && (
                                      <p className="text-xs text-[#0D6E6E] font-medium leading-tight">You</p>
                                    )}
                                  </div>
                                </div>
                                <div className="flex items-center gap-1.5 text-sm font-medium text-gray-600 shrink-0">
                                  <Clock size={14} className="text-gray-500" />
                                  <span>{dateStr}</span>
                                  <span className="text-gray-400">|</span>
                                  <span>{timeStr}</span>
                                </div>
                              </div>
                              {/* Remark body */}
                              <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3">
                                <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">{r.remark}</p>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
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
                              entry.action === "approve" ? "bg-green-500 border-green-500" :
                              entry.action === "reject"  ? "bg-red-500 border-red-500" :
                                                          "bg-[#0D6E6E] border-[#0D6E6E]")}>
                              {entry.action === "approve" ? <CheckCircle2 size={16} className="text-white" /> :
                               entry.action === "reject"  ? <XCircle size={16} className="text-white" /> :
                                                            <ArrowRight size={16} className="text-white" />}
                            </div>
                            {i < trackEntries.length - 1 && <div className="w-0.5 h-10 mt-1 bg-gray-200" />}
                          </div>
                          <div className="flex-1 pb-6">
                            <p className="text-base font-bold text-gray-900 capitalize">{entry.action.replace("_"," ")}</p>
                            <div className="flex items-center gap-2 mt-1 text-sm text-gray-600">
                              <span className="font-medium">{entry.from_user_name ?? "System"}</span>
                              {entry.to_user_name && <>
                                <ArrowRight size={13} className="text-gray-400 shrink-0" />
                                <span className="font-medium">{entry.to_user_name}</span>
                              </>}
                            </div>
                            {entry.remarks && <p className="text-sm text-gray-500 mt-1 italic">&ldquo;{entry.remarks}&rdquo;</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Action Modal */}
      <AnimatePresence>
        {actionModal && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6"
            onClick={() => setActionModal(false)}>
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
              <div className="flex items-center gap-3 mb-5">
                {actionType === "approve" && <CheckCircle2 size={24} className="text-green-600" />}
                {actionType === "forward" && <ArrowRight size={24} className="text-[#0D6E6E]" />}
                {actionType === "reject"  && <XCircle size={24} className="text-red-500" />}
                {actionType === "return"  && <RotateCcw size={24} className="text-amber-600" />}
                <h3 className="text-xl font-bold text-gray-900">
                  {actionType === "forward" ? (isDraft ? "Forward to Recipient" : "Forward File") :
                   actionType === "approve" ? "Approve File" :
                   actionType === "reject"  ? "Reject File" : "Return File"}
                </h3>
              </div>

              {/* Forward / Return: show all users (designation first, then name) */}
              {(actionType === "forward" || actionType === "return") && (
                <div className="mb-4">
                  <label className="block text-base font-semibold text-gray-700 mb-2">
                    {isDraft ? "Select Recipient *" : "Forward To *"}
                  </label>
                  {users.length === 0 ? (
                    <p className="text-sm text-amber-600 bg-amber-50 rounded-xl p-3">No users available.</p>
                  ) : (
                    <select value={toUserId} onChange={(e) => setToUserId(e.target.value)}
                      className="w-full border border-gray-300 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]">
                      <option value="">Select…</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.designation ? `${u.designation} — ` : ""}{u.full_name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={3}
                placeholder={actionType === "reject" ? "Reason for rejection (required)…" : "Add remarks (optional)…"}
                className="w-full border border-gray-300 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E] resize-none mb-4" />

              {/* Attach document (available for all action types) */}
              <div className="mb-4">
                <label className="block text-sm font-semibold text-gray-700 mb-2">Attach Document (optional)</label>
                <label className="flex items-center gap-2 cursor-pointer w-full border-2 border-dashed border-gray-200 hover:border-[#0D6E6E] rounded-xl px-4 py-3 text-sm text-gray-500 hover:text-[#0D6E6E] transition-colors">
                  <Upload size={15} />
                  <span>Browse or drop files…</span>
                  <input type="file" multiple className="sr-only" onChange={(e) => {
                    if (!e.target.files) return;
                    const next = [...modalFiles];
                    Array.from(e.target.files).forEach((f, i) => {
                      const idx = next.length + i + 1;
                      next.push({ file: f, name: f.name, tag: `doc-${idx}` });
                    });
                    setModalFiles(next.slice(0, 10));
                    e.target.value = "";
                  }} />
                </label>
                {modalFiles.length > 0 && (
                  <div className="mt-2 space-y-2">
                    {modalFiles.map((mf, i) => (
                      <div key={i} className="flex items-center gap-2 p-2.5 bg-gray-50 rounded-xl border border-gray-100">
                        <FileText size={15} className="text-[#0D6E6E] shrink-0" />
                        <div className="flex-1 grid grid-cols-2 gap-2">
                          <div>
                            <p className="text-xs text-gray-400 mb-0.5">Name</p>
                            <input value={mf.name}
                              onChange={(e) => setModalFiles((a) => a.map((x, idx) => idx === i ? { ...x, name: e.target.value } : x))}
                              className="w-full border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-[#0D6E6E]" />
                          </div>
                          <div>
                            <p className="text-xs text-gray-400 mb-0.5">Tag</p>
                            <select value={mf.tag}
                              onChange={(e) => setModalFiles((a) => a.map((x, idx) => idx === i ? { ...x, tag: e.target.value } : x))}
                              className="w-full border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-[#0D6E6E]">
                              {[
                                ...Array.from({ length: 10 }, (_, k) => `doc-${k + 1}`),
                                "Annexure 1","Annexure 2","Annexure 3","Annexure 4","Annexure 5",
                                "Annexure A","Annexure B","Annexure C",
                                "Supporting Document","Reference Document",
                                "Enclosure 1","Enclosure 2","Enclosure 3",
                                "Exhibit 1","Exhibit 2",
                                "Proof of Identity","Proof of Address","Certificate","Other",
                              ].map((opt) => (
                                <option key={opt} value={opt}>{opt}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                        <button type="button" onClick={() => setModalFiles((a) => a.filter((_, idx) => idx !== i))}
                          className="text-red-400 hover:text-red-600 shrink-0"><X size={14} /></button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex gap-3">
                <button onClick={() => { setActionModal(false); setToUserId(""); setRemarks(""); setModalFiles([]); }}
                  className="flex-1 py-3 text-base border border-gray-200 rounded-xl hover:bg-gray-50 font-medium">Cancel</button>
                <button
                  onClick={handleSubmitAction}
                  disabled={submitAction.isPending}
                  className={cn("flex-1 py-3 text-base rounded-xl font-bold flex items-center justify-center gap-2",
                    actionType === "reject" ? "bg-red-600 text-white hover:bg-red-700" : "bg-[#0D6E6E] text-white hover:bg-[#178F8F]",
                    "disabled:opacity-50")}>
                  {submitAction.isPending ? <Loader2 size={18} className="animate-spin" /> :
                   actionType === "approve" ? "Confirm Approval" :
                   actionType === "reject"  ? "Confirm Rejection" :
                   actionType === "return"  ? "Return File" : "Forward"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
