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
import { Plus, FolderKanban, CheckCircle2, RotateCcw, UserPlus, Repeat, UserPen } from "lucide-react";
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
  employee_code?: string | null;
  active_role: string | null;
  is_active: boolean;
}

interface DeptOpt { id: string; name: string; is_active: boolean; }
interface RoleOpt { id: string; name: string; is_system: boolean; }

const prettyRole = (name: string) =>
  ({ efms_officer: "eFMS Officer", efms_admin: "eFMS Admin", super_admin: "Super Admin" } as Record<string, string>)[name]
  ?? name.split("_").map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" ");

const INPUT = "w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]";
const LABEL = "block text-sm font-semibold text-gray-600 mb-1";

export function ProjectManagementSection() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", total_funding: "", funding_agency: "", start_date: "", end_date: "" });
  // Optional PI to assign at creation time. Empty string = create unassigned
  // (the existing flow — assign later with the Assign button).
  const [createAssignUserId, setCreateAssignUserId] = useState("");
  const [assignTarget, setAssignTarget] = useState<{ project: Project; mode: "assign" | "reassign" } | null>(null);
  const [assignUserId, setAssignUserId] = useState("");
  // Edit-PI-profile dialog state (super admin: rename / re-designate the
  // project's current PI profile).
  const [editProfileTarget, setEditProfileTarget] = useState<Project | null>(null);
  const [profileForm, setProfileForm] = useState({
    first_name: "", middle_name: "", last_name: "", designation: "",
    mobile: "", department_id: "", role: "", can_sign: false,
  });
  const [profileLoading, setProfileLoading] = useState(false);

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
    // Used by the assign/reassign modal AND the optional PI field in the
    // Create Project form, so it always loads on this screen.
  });
  const candidates = eligibleUsers.filter((u) => u.active_role !== "super_admin");

  // For the Edit-PI modal's Department + Role selects.
  const { data: departments = [] } = useQuery<DeptOpt[]>({
    queryKey: ["admin-departments-all"],
    queryFn: async () => (await api.get("/admin/departments/all")).data,
  });
  const { data: roles = [] } = useQuery<RoleOpt[]>({
    queryKey: ["admin-roles"],
    queryFn: async () => (await api.get("/auth/admin/roles")).data,
  });
  const roleOptions = roles
    .filter((r) => r.name !== "super_admin")
    .map((r) => ({ value: r.name, label: prettyRole(r.name) }));

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
        // Optional — only sent when a PI was picked; otherwise the project
        // is created unassigned exactly as before.
        assign_user_id: createAssignUserId || undefined,
      });
      setForm({ name: "", total_funding: "", funding_agency: "", start_date: "", end_date: "" });
      setCreateAssignUserId("");
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

  async function openEditProfile(p: Project) {
    setEditProfileTarget(p);
    setProfileLoading(true);
    try {
      const { data } = await api.get(`/projects/${p.id}/profile`);
      setProfileForm({
        first_name: data.first_name ?? "",
        middle_name: data.middle_name ?? "",
        last_name: data.last_name ?? "",
        designation: data.designation ?? "",
        mobile: data.mobile ?? "",
        department_id: data.department_id ?? "",
        role: data.active_role ?? "",
        can_sign: !!data.can_sign,
      });
    } catch {
      toast.error("Could not load the PI profile.");
      setEditProfileTarget(null);
    } finally {
      setProfileLoading(false);
    }
  }

  async function handleEditProfileSubmit() {
    if (!editProfileTarget || !profileForm.first_name.trim()) return;
    await act(() =>
      api.patch(`/projects/${editProfileTarget.id}/profile`, {
        first_name: profileForm.first_name.trim(),
        middle_name: profileForm.middle_name.trim() || null,
        last_name: profileForm.last_name.trim() || null,
        designation: profileForm.designation.trim() || null,
        mobile: profileForm.mobile.trim() || null,
        department_id: profileForm.department_id || undefined,
        role: profileForm.role || undefined,
        can_sign: profileForm.can_sign,
      }),
    );
    setEditProfileTarget(null);
  }

  return (
    <div>
      <div className="bg-gray-50 rounded-xl border border-gray-200 p-4 mb-5">
        <p className="text-sm font-semibold text-gray-700 mb-3">Create Project</p>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div><label className={LABEL}>Project Name *</label><input value={form.name} onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))} placeholder="e.g. ABC Research Project" className={INPUT} /></div>
          <div>
            <label className={LABEL}>Assign PI <span className="font-normal text-gray-400">(optional — you can assign later)</span></label>
            <SearchableSelect
              options={candidates.map((u) => ({ value: u.id, label: u.employee_code ? `${u.full_name} (${u.employee_code})` : `${u.full_name} — ${u.email}` }))}
              value={createAssignUserId}
              onChange={setCreateAssignUserId}
              placeholder="Leave empty to assign later"
              searchPlaceholder="Search users…"
            />
          </div>
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
                  <>
                    <button onClick={() => openEditProfile(p)}
                      className="flex items-center gap-1 px-3 py-1.5 border border-gray-300 text-gray-700 rounded-lg text-xs font-semibold hover:bg-gray-50">
                      <UserPen size={13} /> Edit PI
                    </button>
                    <button onClick={() => setAssignTarget({ project: p, mode: "reassign" })}
                      className="flex items-center gap-1 px-3 py-1.5 border border-gray-300 text-gray-700 rounded-lg text-xs font-semibold hover:bg-gray-50">
                      <Repeat size={13} /> Reassign
                    </button>
                  </>
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

      {editProfileTarget && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={() => setEditProfileTarget(null)}>
          <div className="bg-white rounded-2xl p-6 max-w-lg w-full shadow-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 mb-1">
              Edit PI Profile — #{editProfileTarget.project_number}
            </h3>
            <p className="text-sm text-gray-500 mb-4">
              Edit every field of the current PI profile for &quot;{editProfileTarget.name}&quot;. The project
              link and the underlying person are not changed here — use Reassign for that.
            </p>
            {profileLoading ? (
              <p className="text-sm text-gray-400 py-6 text-center">Loading profile…</p>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className={LABEL}>First name *</label>
                    <input value={profileForm.first_name} onChange={(e) => setProfileForm((s) => ({ ...s, first_name: e.target.value }))}
                      placeholder="e.g. Dr. A. Sharma" className={INPUT} />
                  </div>
                  <div>
                    <label className={LABEL}>Middle name</label>
                    <input value={profileForm.middle_name} onChange={(e) => setProfileForm((s) => ({ ...s, middle_name: e.target.value }))}
                      className={INPUT} />
                  </div>
                  <div>
                    <label className={LABEL}>Last name</label>
                    <input value={profileForm.last_name} onChange={(e) => setProfileForm((s) => ({ ...s, last_name: e.target.value }))}
                      placeholder={`e.g. PI${editProfileTarget.project_number}`} className={INPUT} />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                  <div>
                    <label className={LABEL}>Designation</label>
                    <input value={profileForm.designation} onChange={(e) => setProfileForm((s) => ({ ...s, designation: e.target.value }))}
                      placeholder="e.g. Principal Investigator" className={INPUT} />
                  </div>
                  <div>
                    <label className={LABEL}>Mobile</label>
                    <input value={profileForm.mobile} onChange={(e) => setProfileForm((s) => ({ ...s, mobile: e.target.value }))}
                      placeholder="e.g. 9000000001" className={INPUT} />
                  </div>
                  <div>
                    <label className={LABEL}>Department</label>
                    <SearchableSelect
                      options={departments.filter((d) => d.is_active !== false).map((d) => ({ value: d.id, label: d.name }))}
                      value={profileForm.department_id}
                      onChange={(v) => setProfileForm((s) => ({ ...s, department_id: v }))}
                      placeholder="None"
                      searchPlaceholder="Search departments…"
                    />
                  </div>
                  <div>
                    <label className={LABEL}>Role</label>
                    <SearchableSelect
                      options={roleOptions}
                      value={profileForm.role}
                      onChange={(v) => setProfileForm((s) => ({ ...s, role: v }))}
                      clearable={false}
                      placeholder="Select role…"
                      searchPlaceholder="Search roles…"
                    />
                  </div>
                </div>
                <label className="flex items-center gap-2 mt-4 text-sm font-medium text-gray-700 cursor-pointer">
                  <input type="checkbox" checked={profileForm.can_sign}
                    onChange={(e) => setProfileForm((s) => ({ ...s, can_sign: e.target.checked }))}
                    className="w-4 h-4 rounded border-gray-300 text-[#0D6E6E] focus:ring-[#0D6E6E]" />
                  Can sign (e-signature permission)
                </label>
                <div className="flex gap-3 mt-5">
                  <button onClick={() => setEditProfileTarget(null)} className="flex-1 px-4 py-2.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 font-medium">Cancel</button>
                  <button onClick={handleEditProfileSubmit} disabled={!profileForm.first_name.trim()}
                    className="flex-1 px-4 py-2.5 text-sm bg-[#0D6E6E] text-white rounded-lg font-semibold hover:bg-[#178F8F] disabled:opacity-50">
                    Save
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
