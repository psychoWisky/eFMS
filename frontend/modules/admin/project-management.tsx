"use client";
// Super-Admin Projects screen — create projects and assign/reassign a PI
// project profile, mirroring admin-panel.tsx's existing act()/Row-style
// conventions rather than inventing a new admin UI pattern. A project
// profile is created here as an ordinary `users` row (see backend
// app/api/v1/endpoints/projects.py) reachable only via the topnav's Switch
// Profile menu — this screen never edits a profile's own fields directly
// (name/department/designation are inherited/generated, per the confirmed
// architecture).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { toast } from "sonner";
import { confirmAction, showSuccess } from "@/lib/alert";
import { Plus, FolderKanban, CheckCircle2, RotateCcw, UserPlus, Repeat } from "lucide-react";
import { SearchableSelect } from "@/components/shared/searchable-select";

interface Project {
  id: string;
  project_number: string;
  name: string;
  total_funding: number | null;
  funding_agency: string | null;
  start_date: string | null;
  end_date: string | null;
  status: "active" | "completed";
  current_profile_id: string | null;
  current_profile_name: string | null;
}

interface AdminUser {
  id: string;
  full_name: string;
  email: string;
  active_role: string | null;
  is_active: boolean;
}

const INPUT = "w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]";
const LABEL = "block text-sm font-semibold text-gray-600 mb-1";

export function ProjectManagementSection() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", total_funding: "", funding_agency: "", start_date: "", end_date: "" });
  const [assignTarget, setAssignTarget] = useState<{ project: Project; mode: "assign" | "reassign" } | null>(null);
  const [assignUserId, setAssignUserId] = useState("");

  const { data: projects = [], isLoading } = useQuery<Project[]>({
    queryKey: ["projects"],
    queryFn: async () => (await api.get("/projects")).data,
  });

  // Only real people (never a project profile — the backend excludes them
  // from this endpoint already) and never Super Admin, who can't be
  // assigned a project profile (enforced server-side too).
  const { data: eligibleUsers = [] } = useQuery<AdminUser[]>({
    queryKey: ["auth-admin-users", "active"],
    queryFn: async () => (await api.get("/auth/admin/users?status=active")).data,
    enabled: !!assignTarget,
  });
  const candidates = eligibleUsers.filter((u) => u.active_role !== "super_admin");

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      qc.invalidateQueries({ queryKey: ["projects"] });
      showSuccess("Done");
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(msg ?? "Action failed");
    }
  }

  async function handleCreate() {
    if (!form.name.trim()) return;
    await act(async () => {
      await api.post("/projects", {
        name: form.name,
        total_funding: form.total_funding ? Number(form.total_funding) : undefined,
        funding_agency: form.funding_agency || undefined,
        start_date: form.start_date || undefined,
        end_date: form.end_date || undefined,
      });
      setForm({ name: "", total_funding: "", funding_agency: "", start_date: "", end_date: "" });
    });
  }

  async function handleAssignSubmit() {
    if (!assignTarget || !assignUserId) return;
    const path = assignTarget.mode === "assign" ? "assign" : "reassign";
    await act(() => api.post(`/projects/${assignTarget.project.id}/${path}`, { user_id: assignUserId }));
    setAssignTarget(null);
    setAssignUserId("");
  }

  async function handleComplete(p: Project) {
    const confirmed = await confirmAction({
      title: "Mark this project as completed?",
      text: `"${p.name}" (#${p.project_number}) will be marked completed and its project profile${p.current_profile_name ? ` ("${p.current_profile_name}")` : ""} will no longer be usable — it cannot be switched into, forward, receive, or be selected as a recipient. All existing files/history remain fully accessible under the normal rules.`,
      confirmText: "Complete Project",
      danger: true,
    });
    if (confirmed) act(() => api.patch(`/projects/${p.id}/complete`, {}));
  }

  async function handleReactivate(p: Project) {
    act(() => api.patch(`/projects/${p.id}/reactivate`, {}));
  }

  return (
    <div>
      <div className="bg-gray-50 rounded-xl border border-gray-200 p-4 mb-5">
        <p className="text-sm font-semibold text-gray-700 mb-3">Create Project</p>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div className="col-span-2"><label className={LABEL}>Project Name *</label><input value={form.name} onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))} placeholder="e.g. ABC Research Project" className={INPUT} /></div>
          <div><label className={LABEL}>Funding Agency</label><input value={form.funding_agency} onChange={(e) => setForm((s) => ({ ...s, funding_agency: e.target.value }))} placeholder="e.g. ICAR" className={INPUT} /></div>
          <div><label className={LABEL}>Total Funding</label><input type="number" value={form.total_funding} onChange={(e) => setForm((s) => ({ ...s, total_funding: e.target.value }))} placeholder="e.g. 2500000" className={INPUT} /></div>
          <div><label className={LABEL}>Start Date</label><input type="date" value={form.start_date} onChange={(e) => setForm((s) => ({ ...s, start_date: e.target.value }))} className={INPUT} /></div>
          <div><label className={LABEL}>End Date</label><input type="date" value={form.end_date} onChange={(e) => setForm((s) => ({ ...s, end_date: e.target.value }))} className={INPUT} /></div>
        </div>
        <button onClick={handleCreate} disabled={!form.name.trim()}
          className="flex items-center gap-1 px-4 py-2.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-semibold hover:bg-[#178F8F] disabled:opacity-50 whitespace-nowrap">
          <Plus size={15} /> Create Project
        </button>
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-400 py-4">Loading projects…</p>
      ) : projects.length === 0 ? (
        <p className="text-sm text-gray-400 py-4">No projects created yet.</p>
      ) : (
        <div className="space-y-2">
          {projects.map((p) => (
            <div key={p.id} className={`flex items-center justify-between px-4 py-3 rounded-lg border ${p.status === "active" ? "bg-white border-gray-200" : "bg-gray-50 border-gray-100 opacity-70"}`}>
              <div className="min-w-0 flex-1 flex items-start gap-3">
                <FolderKanban size={18} className="text-[#0D6E6E] shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-base font-semibold text-gray-900 truncate">
                    #{p.project_number} — {p.name}
                    <span className={`ml-2 px-2 py-0.5 rounded-full text-xs font-medium ${p.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-gray-200 text-gray-600"}`}>
                      {p.status === "active" ? "Active" : "Completed"}
                    </span>
                  </p>
                  <p className="text-sm text-gray-500 truncate">
                    {p.funding_agency ?? "—"} {p.total_funding ? `· ₹${Number(p.total_funding).toLocaleString()}` : ""}
                  </p>
                  <p className="text-sm text-gray-600 mt-0.5">
                    PI: {p.current_profile_name ?? <span className="text-gray-400 italic">Not assigned</span>}
                  </p>
                </div>
              </div>
              <div className="flex gap-1 ml-3 shrink-0">
                {!p.current_profile_id ? (
                  <button onClick={() => setAssignTarget({ project: p, mode: "assign" })}
                    className="flex items-center gap-1 px-3 py-1.5 bg-[#0D6E6E] text-white rounded-lg text-xs font-semibold hover:bg-[#178F8F]">
                    <UserPlus size={13} /> Assign
                  </button>
                ) : p.status === "active" ? (
                  <button onClick={() => setAssignTarget({ project: p, mode: "reassign" })}
                    className="flex items-center gap-1 px-3 py-1.5 border border-gray-300 text-gray-700 rounded-lg text-xs font-semibold hover:bg-gray-50">
                    <Repeat size={13} /> Reassign
                  </button>
                ) : null}
                {p.status === "active" ? (
                  <button onClick={() => handleComplete(p)}
                    className="flex items-center gap-1 px-3 py-1.5 border border-amber-300 text-amber-700 rounded-lg text-xs font-semibold hover:bg-amber-50">
                    <CheckCircle2 size={13} /> Complete
                  </button>
                ) : (
                  <button onClick={() => handleReactivate(p)}
                    className="flex items-center gap-1 px-3 py-1.5 border border-emerald-300 text-emerald-700 rounded-lg text-xs font-semibold hover:bg-emerald-50">
                    <RotateCcw size={13} /> Reactivate
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {assignTarget && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={() => setAssignTarget(null)}>
          <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 mb-1">
              {assignTarget.mode === "assign" ? "Assign PI" : "Reassign PI"} — #{assignTarget.project.project_number}
            </h3>
            <p className="text-sm text-gray-500 mb-4">
              {assignTarget.mode === "reassign"
                ? `The current profile ("${assignTarget.project.current_profile_name}") will be deactivated but kept for historical records. A new project profile will be created for the selected person.`
                : `A new project-specific profile will be created for the selected person automatically, named "<Their Name> PI${assignTarget.project.project_number}".`}
            </p>
            <label className={LABEL}>Select User *</label>
            <SearchableSelect
              options={candidates.map((u) => ({ value: u.id, label: `${u.full_name} — ${u.email}` }))}
              value={assignUserId}
              onChange={setAssignUserId}
              clearable={false}
              placeholder="Choose a user…"
              searchPlaceholder="Search by name or email…"
            />
            <div className="flex gap-3 mt-5">
              <button onClick={() => setAssignTarget(null)} className="flex-1 px-4 py-2.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 font-medium">Cancel</button>
              <button onClick={handleAssignSubmit} disabled={!assignUserId}
                className="flex-1 px-4 py-2.5 text-sm bg-[#0D6E6E] text-white rounded-lg font-semibold hover:bg-[#178F8F] disabled:opacity-50">
                {assignTarget.mode === "assign" ? "Assign" : "Reassign"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
