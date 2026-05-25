"use client";
// Dashboard: 3 sections — Docket, Files, New File Creation
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api } from "@/services/api";
import { useUser, useActiveRole } from "@/stores/auth.store";
import { cn, formatDate } from "@/lib/utils";
import { Inbox, FolderOpen, FilePlus2, Loader2, Unlock, Eye, EyeOff, AlertCircle, Clock } from "lucide-react";
import { toast } from "sonner";
import { NewFileForm } from "@/modules/files/new-file-page";

interface EfmsFile {
  id: string; ref_number: string; subject: string; category: string;
  status: string; priority: string; created_at: string; updated_at: string;
  recipient_name: string | null; created_by: string;
}
interface DocketItem {
  file_id: string; ref_number: string; subject: string; category: string;
  status: string; priority: string; created_by: string;
  current_holder_id: string | null; updated_at: string; created_at: string;
  can_release: boolean; from_user_name: string | null;
}
interface ReleasedItem {
  docket_id: string; file_id: string; ref_number: string; subject: string;
  category: string; status: string; released_at: string | null; created_by: string;
}

type Section = "docket" | "files" | "new";

const STATUS_COLOR: Record<string, string> = {
  draft:        "bg-gray-100 text-gray-600",
  pending:      "bg-amber-100 text-amber-700",
  under_review: "bg-blue-100 text-blue-700",
  approved:     "bg-green-100 text-green-700",
  rejected:     "bg-red-100 text-red-700",
  dispatched:   "bg-teal-100 text-teal-700",
};

function daysAgo(d: string) { return Math.floor((Date.now() - new Date(d).getTime()) / 86400000); }

export function EFMSDashboard() {
  const router = useRouter();
  const user = useUser();
  const role = useActiveRole();
  const qc = useQueryClient();
  const [section, setSection] = useState<Section>("docket");
  const [readFiles, setReadFiles] = useState<Set<string>>(new Set());

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

  // Released dept files: visible to all dept members in Files section
  const { data: releasedFiles = [], isLoading: loadReleased } = useQuery<ReleasedItem[]>({
    queryKey: ["docket-released"],
    queryFn: async () => (await api.get("/docket/released")).data,
  });

  const releaseMutation = useMutation({
    mutationFn: (fileId: string) => api.post(`/docket/${fileId}/release`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-docket"] });
      qc.invalidateQueries({ queryKey: ["docket-released"] });
      toast.success("File released to your department.");
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(msg ?? "Could not release file.");
    },
  });

  const SECTIONS: { id: Section; label: string; icon: React.ElementType; count?: number }[] = [
    { id: "docket", label: "Docket",   icon: Inbox,      count: docketItems.length },
    { id: "files",  label: "My Files", icon: FolderOpen, count: myFiles.length },
    { id: "new",    label: "New File", icon: FilePlus2 },
  ];

  function markRead(id: string) { setReadFiles((s) => new Set([...s, id])); }

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
            <button key={s.id} onClick={() => setSection(s.id)}
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

            {loadDocket ? (
              <div className="flex items-center justify-center py-16 gap-3 text-gray-400"><Loader2 size={22} className="animate-spin" /> Loading…</div>
            ) : docketItems.length === 0 ? (
              <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
                <Inbox size={40} className="mx-auto mb-3 text-gray-200" />
                <p className="text-lg font-semibold text-gray-600">Your docket is empty</p>
                <p className="text-base text-gray-400 mt-1">Files forwarded to you will appear here.</p>
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      {["Ref Number", "Subject", "From", "Priority", "Received", "Status", "Action"].map((h) => (
                        <th key={h} className="text-left px-5 py-4 text-base font-semibold text-gray-600">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {docketItems.map((f) => {
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
                          <td className="px-5 py-4 text-base text-gray-600">{f.from_user_name ?? "—"}</td>
                          <td className="px-5 py-4">
                            <span className={cn("px-2 py-1 rounded-full text-sm font-medium capitalize",
                              f.priority === "urgent" ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-600")}>
                              {f.priority === "urgent" && <AlertCircle size={12} className="inline mr-1" />}{f.priority}
                            </span>
                          </td>
                          <td className="px-5 py-4 text-base text-gray-500">
                            <span>{formatDate(f.updated_at, "relative")}</span>
                            {days >= 3 && <span className="block text-sm text-red-500 font-semibold">{days}d waiting</span>}
                          </td>
                          <td className="px-5 py-4">
                            <span className={cn("px-2 py-1 rounded-full text-sm font-medium", STATUS_COLOR[f.status] ?? "bg-gray-100 text-gray-600")}>
                              {f.status.replace("_"," ")}
                            </span>
                          </td>
                          <td className="px-5 py-4">
                            <div className="flex items-center gap-2 flex-wrap">
                              <button onClick={() => { markRead(f.file_id); router.push(`/files/${f.file_id}`); }}
                                className="flex items-center gap-1 px-3 py-1.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-medium hover:bg-[#178F8F]">
                                <Eye size={14} /> View
                              </button>
                              {f.can_release && (
                                <button onClick={() => releaseMutation.mutate(f.file_id)}
                                  disabled={releaseMutation.isPending}
                                  className="flex items-center gap-1 px-3 py-1.5 border border-teal-300 text-teal-700 rounded-lg text-sm font-medium hover:bg-teal-50 disabled:opacity-50">
                                  <Unlock size={14} /> Release
                                </button>
                              )}
                              <button onClick={() => router.push(`/files/${f.file_id}`)}
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

            {loadFiles ? (
              <div className="flex items-center justify-center py-10 gap-3 text-gray-400"><Loader2 size={22} className="animate-spin" /> Loading…</div>
            ) : myFiles.length === 0 ? (
              <div className="bg-white rounded-2xl border border-gray-200 p-10 text-center">
                <FolderOpen size={40} className="mx-auto mb-3 text-gray-200" />
                <p className="text-lg font-semibold text-gray-600">No files yet</p>
                <button onClick={() => setSection("new")} className="mt-4 px-5 py-2.5 bg-[#0D6E6E] text-white rounded-xl text-base font-semibold hover:bg-[#178F8F]">Create your first file</button>
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      {["Note ID", "File Category", "File / Doc Number", "Dispatched On", "Status", "Action"].map((h) => (
                        <th key={h} className="text-left px-5 py-4 text-base font-semibold text-gray-600">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {myFiles.map((f, idx) => (
                      <tr key={f.id} className="hover:bg-gray-50">
                        <td className="px-5 py-4 text-base text-gray-500 font-mono">{(idx + 1).toString().padStart(4, "0")}</td>
                        <td className="px-5 py-4 text-base text-gray-700">{f.category}</td>
                        <td className="px-5 py-4">
                          <span className="font-mono text-sm font-bold text-[#0D6E6E] bg-[#E6F4F4] px-2 py-1 rounded">{f.ref_number}</span>
                        </td>
                        <td className="px-5 py-4 text-base text-gray-500">
                          {f.status === "dispatched" ? formatDate(f.updated_at, "relative") : "—"}
                        </td>
                        <td className="px-5 py-4">
                          <span className={cn("px-2 py-1 rounded-full text-sm font-medium", STATUS_COLOR[f.status] ?? "bg-gray-100")}>
                            {f.status.replace("_"," ")}
                          </span>
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
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Released dept files */}
            {(loadReleased || releasedFiles.length > 0) && (
              <div>
                <h2 className="text-xl font-bold text-[#1A1A2E] mt-2">Department Files</h2>
                <p className="text-base text-gray-500 mt-0.5">Files released by colleagues in your department.</p>

                {loadReleased ? (
                  <div className="flex items-center justify-center py-10 gap-3 text-gray-400 mt-3"><Loader2 size={22} className="animate-spin" /> Loading…</div>
                ) : (
                  <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden mt-3">
                    <table className="w-full">
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
                              <span className={cn("px-2 py-1 rounded-full text-sm font-medium", STATUS_COLOR[d.status] ?? "bg-gray-100")}>{d.status.replace("_"," ")}</span>
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
                )}
              </div>
            )}
          </div>
        )}

        {/* ── NEW FILE SECTION ── */}
        {section === "new" && (
          <div>
            <h2 className="text-xl font-bold text-[#1A1A2E] mb-1">Create New File</h2>
            <p className="text-base text-gray-500 mb-5">Fill in the details and submit your file for routing.</p>
            <NewFileForm onSuccess={() => { qc.invalidateQueries({ queryKey: ["efms-files-outbox"] }); setSection("files"); }} />
          </div>
        )}
      </div>
    </div>
  );
}
