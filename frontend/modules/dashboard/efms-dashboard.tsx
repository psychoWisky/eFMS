"use client";
// Dashboard: 3 sections — Docket, Files, New File Creation
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api } from "@/services/api";
import { useUser, useActiveRole } from "@/stores/auth.store";
import { cn, formatDate, matchesRefSuffix, truncate } from "@/lib/utils";
import { Inbox, FolderOpen, FilePlus2, Loader2, Unlock, Eye, EyeOff, Clock, Search, FilePlus, FolderSearch } from "lucide-react";
import { toast } from "sonner";
import { confirmAction, showSuccess } from "@/lib/alert";
import { guardedNavigate } from "@/hooks/use-unsaved-changes-guard";
import { NewFileForm } from "@/modules/files/new-file-page";
import { ReopenFilePicker } from "@/modules/files/reopen-file-picker";
import { PersonBadge, type PersonInfo } from "@/components/shared/person-badge";
import { FileClassificationBadge } from "@/components/shared/file-classification-badge";

interface EfmsFile {
  id: string; ref_number: string; subject: string; category: string;
  status: string; priority: string; created_at: string; updated_at: string;
  recipient_name: string | null; created_by: string; is_released: boolean;
  current_holder_id: string | null; current_holder_info: PersonInfo | null;
}
interface DocketItem {
  file_id: string; ref_number: string; subject: string; category: string;
  status: string; priority: string; created_by: string;
  current_holder_id: string | null; updated_at: string; created_at: string;
  can_release: boolean; from_user_name: string | null; from_user_info?: PersonInfo | null;
}
interface ReleasedItem {
  docket_id: string; file_id: string; ref_number: string; subject: string;
  category: string; released_at: string | null;
}

type Section = "docket" | "files" | "new";

// Docket entries are always Active by definition, so no Status column/map is
// needed there. My Files/Released only ever display draft/active/released.
const STATUS_COLOR: Record<string, string> = {
  draft:    "bg-gray-100 text-gray-600",
  active:   "bg-amber-100 text-amber-700",
  released: "bg-green-100 text-green-700",
};

function daysAgo(d: string) { return Math.floor((Date.now() - new Date(d).getTime()) / 86400000); }

export function EFMSDashboard() {
  const router = useRouter();
  const user = useUser();
  const role = useActiveRole();
  const qc = useQueryClient();
  const [section, setSection] = useState<Section>("docket");
  // "NEW" badge read-state: persisted in localStorage (not a backend field —
  // there's no product requirement for cross-device sync here) and keyed
  // per-user so one account's read state on this browser never bleeds into
  // another account's dashboard. Deliberately separate from
  // Notification.is_read, which is a different, backend-persisted concept.
  const [readFiles, setReadFiles] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!user?.id) return;
    try {
      const raw = localStorage.getItem(`efms-read-files-${user.id}`);
      if (raw) setReadFiles(new Set(JSON.parse(raw)));
    } catch { /* ignore corrupt/inaccessible storage */ }
  }, [user?.id]);
  const [newFileMode, setNewFileMode] = useState<"choice" | "create" | "reopen">("choice");
  const [docketSearch, setDocketSearch] = useState("");
  const [myFilesSearch, setMyFilesSearch] = useState("");

  // Docket: files currently held by me — poll every 10s so new forwards appear without manual refresh
  const { data: docketItems = [], isLoading: loadDocket } = useQuery<DocketItem[]>({
    queryKey: ["my-docket"],
    queryFn: async () => (await api.get("/docket")).data,
    refetchInterval: 10_000,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  // My Files: files I created
  const { data: myFiles = [], isLoading: loadFiles } = useQuery<EfmsFile[]>({
    queryKey: ["efms-files-outbox"],
    queryFn: async () => (await api.get("/efms/files?outbox=true")).data,
  });

  // Released Files: files the current user themself created AND released —
  // GET /docket/released/mine already scopes by released_by == me (and, since
  // only the creator can ever release a file, created_by == me too), so this
  // never includes files released by other department members. Deliberately
  // NOT /docket/released (department-wide) — that endpoint is left in place
  // for any other consumer, just no longer used by this dashboard.
  const { data: releasedFiles = [], isLoading: loadReleased } = useQuery<ReleasedItem[]>({
    queryKey: ["docket-released-mine"],
    queryFn: async () => (await api.get("/docket/released/mine")).data,
  });

  const releaseMutation = useMutation({
    mutationFn: (fileId: string) => api.post(`/docket/${fileId}/release`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-docket"] });
      qc.invalidateQueries({ queryKey: ["docket-released-mine"] });
      showSuccess("File released to your department.");
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(msg ?? "Could not release file.");
    },
  });

  // Search matches only the trailing numeric segment of the ref number
  // (e.g. "0003" in AVFU/AGRO/2026/GEN/0003), leading-zero insensitive.
  const filteredDocketItems = docketItems.filter((f) => matchesRefSuffix(f.ref_number, docketSearch));
  const filteredMyFiles = myFiles.filter((f) => matchesRefSuffix(f.ref_number, myFilesSearch));

  const SECTIONS: { id: Section; label: string; icon: React.ElementType; count?: number }[] = [
    { id: "docket", label: "Docket",   icon: Inbox,      count: docketItems.length },
    { id: "files",  label: "My Files", icon: FolderOpen, count: myFiles.length },
    { id: "new",    label: "New File", icon: FilePlus2 },
  ];

  function markRead(id: string) {
    setReadFiles((s) => {
      if (s.has(id)) return s;
      const next = new Set(s).add(id);
      if (user?.id) {
        try { localStorage.setItem(`efms-read-files-${user.id}`, JSON.stringify([...next])); } catch { /* ignore quota/storage errors */ }
      }
      return next;
    });
  }

  return (
    <div className="min-h-screen bg-[#F5F7FA]">
      {/* Top header */}
      <div className="bg-white border-b border-gray-200 px-8 py-5">
        <h1 className="text-2xl font-bold text-[#1A1A2E]">eFMS Workspace</h1>
        <p className="text-base text-[#4A5568] mt-0.5">{user?.full_name} · {role?.replace("_"," ")}</p>
      </div>

      {/* Section tabs */}
      <div className="bg-white border-b border-gray-200 px-8">
        <div className="flex gap-1">
          {SECTIONS.map((s) => (
            <button key={s.id} onClick={() => guardedNavigate(() => setSection(s.id))}
              className={cn("flex items-center gap-2 px-6 py-4 text-base font-semibold border-b-2 transition-colors",
                section === s.id ? "border-[#0D6E6E] text-[#0D6E6E]" : "border-transparent text-gray-500 hover:text-gray-700")}>
              <s.icon size={18} /> {s.label}
              {s.count !== undefined && s.count > 0 && (
                <span className={cn("px-2 py-0.5 rounded-full text-xs font-bold",
                  section === s.id ? "bg-[#0D6E6E] text-white" : "bg-gray-100 text-gray-600")}>
                  {s.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="px-8 py-6">

        {/* ── DOCKET SECTION ── */}
        {section === "docket" && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold text-[#1A1A2E]">Docket</h2>
              <p className="text-base text-gray-500 mt-0.5">
                Files forwarded to you. If you created the file, you can release it to make it visible to your department.
              </p>
            </div>

            <div className="relative max-w-xs">
              <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
              <input value={docketSearch} onChange={(e) => setDocketSearch(e.target.value)} placeholder="Search by file number…"
                className="w-full border border-gray-300 rounded-xl pl-10 pr-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]" />
            </div>

            {loadDocket ? (
              <div className="flex items-center justify-center py-16 gap-3 text-gray-400"><Loader2 size={22} className="animate-spin" /> Loading…</div>
            ) : docketItems.length === 0 ? (
              <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
                <Inbox size={40} className="mx-auto mb-3 text-gray-200" />
                <p className="text-lg font-semibold text-gray-600">Your docket is empty</p>
                <p className="text-base text-gray-400 mt-1">Files forwarded to you will appear here.</p>
              </div>
            ) : filteredDocketItems.length === 0 ? (
              <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
                <p className="text-base text-gray-400">No files match your search.</p>
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
                {/* The horizontal scrollbar (if any) belongs to this inner
                    wrapper only — min-w keeps columns from over-compressing
                    on narrow screens instead of the page itself overflowing. */}
                <div className="w-full overflow-x-auto">
                <table className="w-full min-w-[900px]">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      {["Ref Number", "Subject", "From", "Priority", "Received", "Action"].map((h) => (
                        <th key={h} className="text-left px-5 py-4 text-base font-semibold text-gray-600">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filteredDocketItems.map((f) => {
                      const isNew = !readFiles.has(f.file_id);
                      const days = daysAgo(f.updated_at);
                      return (
                        <tr key={f.file_id} className={cn("hover:bg-gray-50 transition-colors", isNew && "bg-blue-50/40")}>
                          <td className="px-5 py-4">
                            <span className="font-mono text-sm font-bold text-[#0D6E6E] bg-[#E6F4F4] px-2 py-1 rounded">{f.ref_number}</span>
                            {isNew && <span className="ml-2 text-xs bg-blue-500 text-white px-1.5 py-0.5 rounded-full font-semibold">NEW</span>}
                          </td>
                          <td className="px-5 py-4 max-w-xs">
                            <p className="text-base font-semibold text-gray-900 truncate">{f.subject}</p>
                          </td>
                          <td className="px-5 py-4 text-base text-gray-600"><PersonBadge person={f.from_user_info} compact /></td>
                          <td className="px-5 py-4"><FileClassificationBadge priority={f.priority} /></td>
                          <td className="px-5 py-4 text-base text-gray-500">
                            <span>{formatDate(f.updated_at, "relative")}</span>
                            {days >= 3 && <span className="block text-sm text-red-500 font-semibold">{days}d waiting</span>}
                          </td>
                          <td className="px-5 py-4">
                            <div className="flex items-center gap-2 flex-wrap">
                              <button onClick={() => { markRead(f.file_id); router.push(`/files/${f.file_id}`); }}
                                className="flex items-center gap-1 px-3 py-1.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-medium hover:bg-[#178F8F]">
                                <Eye size={14} /> View
                              </button>
                              {f.can_release && (
                                <button onClick={async () => {
                                  const confirmed = await confirmAction({
                                    title: "Release Notesheet?",
                                    text: "Are you sure you want to release this notesheet? You will no longer be able to edit it after release.",
                                    confirmText: "Release",
                                    danger: true,
                                  });
                                  if (confirmed) releaseMutation.mutate(f.file_id);
                                }}
                                  disabled={releaseMutation.isPending}
                                  className="flex items-center gap-1 px-3 py-1.5 border border-teal-300 text-teal-700 rounded-lg text-sm font-medium hover:bg-teal-50 disabled:opacity-50">
                                  <Unlock size={14} /> Release
                                </button>
                              )}
                              <button onClick={() => { markRead(f.file_id); router.push(`/files/${f.file_id}`); }}
                                title="Track status"
                                className="flex items-center gap-1 px-2 py-1.5 text-gray-600 border border-gray-200 rounded-lg text-sm hover:bg-gray-50">
                                <Clock size={14} /> Track
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── FILES SECTION ── */}
        {section === "files" && (
          <div className="space-y-6">
            {/* My created files */}
            <div>
              <h2 className="text-xl font-bold text-[#1A1A2E]">My Files</h2>
              <p className="text-base text-gray-500 mt-0.5">Files you have created.</p>
            </div>

            <div className="relative max-w-xs">
              <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
              <input value={myFilesSearch} onChange={(e) => setMyFilesSearch(e.target.value)} placeholder="Search by file number…"
                className="w-full border border-gray-300 rounded-xl pl-10 pr-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]" />
            </div>

            {loadFiles ? (
              <div className="flex items-center justify-center py-10 gap-3 text-gray-400"><Loader2 size={22} className="animate-spin" /> Loading…</div>
            ) : myFiles.length === 0 ? (
              <div className="bg-white rounded-2xl border border-gray-200 p-10 text-center">
                <FolderOpen size={40} className="mx-auto mb-3 text-gray-200" />
                <p className="text-lg font-semibold text-gray-600">No files yet</p>
                <button onClick={() => setSection("new")} className="mt-4 px-5 py-2.5 bg-[#0D6E6E] text-white rounded-xl text-base font-semibold hover:bg-[#178F8F]">Create your first file</button>
              </div>
            ) : filteredMyFiles.length === 0 ? (
              <div className="bg-white rounded-2xl border border-gray-200 p-10 text-center">
                <p className="text-base text-gray-400">No files match your search.</p>
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
                <div className="w-full overflow-x-auto">
                <table className="w-full min-w-[960px]">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      {["Note ID", "Subject", "File Category", "File / Doc Number", "Created At", "Status", "Current Holder", "Action"].map((h) => (
                        <th key={h} className="text-left px-5 py-4 text-base font-semibold text-gray-600">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filteredMyFiles.map((f, idx) => {
                      // Released overrides the underlying workflow status for display —
                      // users only ever see Draft, Active, or Released here.
                      const displayStatus = f.is_released ? "released" : f.status;
                      return (
                      <tr key={f.id} className="hover:bg-gray-50">
                        <td className="px-5 py-4 text-base text-gray-500 font-mono">{(idx + 1).toString().padStart(4, "0")}</td>
                        <td className="px-5 py-4 text-base text-gray-900 max-w-xs truncate" title={f.subject}>{truncate(f.subject, 60)}</td>
                        <td className="px-5 py-4 text-base text-gray-700">{f.category}</td>
                        <td className="px-5 py-4">
                          <span className="font-mono text-sm font-bold text-[#0D6E6E] bg-[#E6F4F4] px-2 py-1 rounded">{f.ref_number}</span>
                        </td>
                        <td className="px-5 py-4 text-base text-gray-500">{formatDate(f.created_at, "relative")}</td>
                        <td className="px-5 py-4">
                          <span className={cn("px-2 py-1 rounded-full text-sm font-medium", STATUS_COLOR[displayStatus] ?? "bg-gray-100")}>
                            {displayStatus}
                          </span>
                        </td>
                        <td className="px-5 py-4">
                          {f.current_holder_id ? (
                            <PersonBadge person={f.current_holder_info} fallback="Unknown" compact />
                          ) : (
                            <span className="text-sm text-gray-400 italic">
                              {f.is_released ? "Released — no current holder" : "—"}
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-2">
                            <button onClick={() => { markRead(f.id); router.push(`/files/${f.id}`); }}
                              className="flex items-center gap-1 px-3 py-1.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-medium hover:bg-[#178F8F]">
                              <Eye size={14} /> View
                            </button>
                            <button onClick={() => router.push(`/files/${f.id}`)}
                              className="flex items-center gap-1 px-2 py-1.5 text-gray-600 border border-gray-200 rounded-lg text-sm hover:bg-gray-50">
                              <Clock size={14} /> Track
                            </button>
                          </div>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              </div>
            )}

            {/* Released dept files */}
            {(loadReleased || releasedFiles.length > 0) && (
              <div>
                <h2 className="text-xl font-bold text-[#1A1A2E] mt-2">Released Files</h2>
                <p className="text-base text-gray-500 mt-0.5">Files you have released.</p>

                {loadReleased ? (
                  <div className="flex items-center justify-center py-10 gap-3 text-gray-400 mt-3"><Loader2 size={22} className="animate-spin" /> Loading…</div>
                ) : (
                  <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden mt-3">
                    <div className="w-full overflow-x-auto">
                    <table className="w-full min-w-[800px]">
                      <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                          {["Ref Number", "Subject", "Category", "Released", "Status", "Action"].map((h) => (
                            <th key={h} className="text-left px-5 py-4 text-base font-semibold text-gray-600">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {releasedFiles.map((d) => (
                          <tr key={d.docket_id} className="hover:bg-gray-50 bg-green-50/20">
                            <td className="px-5 py-4">
                              <span className="font-mono text-sm font-bold text-green-700 bg-green-100 px-2 py-1 rounded">{d.ref_number}</span>
                              <span className="ml-2 text-xs bg-green-500 text-white px-1.5 py-0.5 rounded-full">Released</span>
                            </td>
                            <td className="px-5 py-4 max-w-xs"><p className="text-base font-semibold text-gray-900 truncate">{d.subject}</p></td>
                            <td className="px-5 py-4 text-base text-gray-600">{d.category}</td>
                            <td className="px-5 py-4 text-base text-gray-500">{d.released_at ? formatDate(d.released_at, "relative") : "—"}</td>
                            <td className="px-5 py-4">
                              <span className={cn("px-2 py-1 rounded-full text-sm font-medium", STATUS_COLOR.released)}>released</span>
                            </td>
                            <td className="px-5 py-4">
                              <button onClick={() => router.push(`/files/${d.file_id}`)}
                                className="flex items-center gap-1 px-3 py-1.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-medium hover:bg-[#178F8F]">
                                <Eye size={14} /> View
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── NEW FILE SECTION ── */}
        {section === "new" && (
          <div>
            {newFileMode === "choice" && (
              <div>
                <h2 className="text-xl font-bold text-[#1A1A2E] mb-1">New File</h2>
                <p className="text-base text-gray-500 mb-5">Start a brand-new file, or reopen one of your own released files to continue its workflow.</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <button onClick={() => setNewFileMode("create")}
                    className="text-left bg-white rounded-2xl border border-gray-200 p-6 hover:border-[#0D6E6E] hover:shadow-sm transition-all">
                    <div className="w-11 h-11 rounded-xl bg-[#E6F4F4] flex items-center justify-center mb-4">
                      <FilePlus size={20} className="text-[#0D6E6E]" />
                    </div>
                    <p className="text-lg font-bold text-gray-900">Create New File</p>
                    <p className="text-base text-gray-500 mt-1">Start a brand-new file from scratch.</p>
                  </button>
                  <button onClick={() => setNewFileMode("reopen")}
                    className="text-left bg-white rounded-2xl border border-gray-200 p-6 hover:border-[#0D6E6E] hover:shadow-sm transition-all">
                    <div className="w-11 h-11 rounded-xl bg-[#E6F4F4] flex items-center justify-center mb-4">
                      <FolderSearch size={20} className="text-[#0D6E6E]" />
                    </div>
                    <p className="text-lg font-bold text-gray-900">Use Existing Released File</p>
                    <p className="text-base text-gray-500 mt-1">Reopen one of your own released files.</p>
                  </button>
                </div>
              </div>
            )}

            {newFileMode === "create" && (
              <div>
                <button onClick={() => guardedNavigate(() => setNewFileMode("choice"))} className="text-sm text-[#0D6E6E] hover:underline mb-4">← Back</button>
                <h2 className="text-xl font-bold text-[#1A1A2E] mb-1">Create New File</h2>
                <p className="text-base text-gray-500 mb-5">Fill in the details and submit your file for routing.</p>
                <NewFileForm onSuccess={() => { qc.invalidateQueries({ queryKey: ["efms-files-outbox"] }); setNewFileMode("choice"); setSection("files"); }} />
              </div>
            )}

            {newFileMode === "reopen" && (
              <ReopenFilePicker
                onBack={() => setNewFileMode("choice")}
                onReopened={(fileId) => { setNewFileMode("choice"); router.push(`/files/${fileId}`); }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
