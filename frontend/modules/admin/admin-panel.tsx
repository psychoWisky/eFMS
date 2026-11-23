"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { toast } from "sonner";
import { confirmAction, showSuccess, showBlocked, apiErrorDetail } from "@/lib/alert";
import {
  Plus, Trash2, Eye, EyeOff, Tag, Users, Building2, Layers,
  Loader2, AlertTriangle, PenLine, ShieldX, ShieldCheck, FolderKanban,
  Landmark, Copy, Pencil, X, ChevronDown, ChevronUp,
} from "lucide-react";
import { UserManagementSection } from "./user-management";
import { RoleManagementSection } from "./role-management";
import { ProjectManagementSection } from "./project-management";
import { DepartmentManagementSection, CreateDepartmentModal, EditNameCodeModal } from "./department-management";
import { MultiDesignationSection } from "./multi-designation";
import { FocAdminPage } from "@/modules/foc/foc-admin";
import { FOC_ENABLED } from "@/lib/foc";
import { SearchableSelect } from "@/components/shared/searchable-select";

interface Item { id: string; name: string; is_active: boolean; label?: string; designation?: string; email?: string; user_id?: string; code?: string; establishment_id?: string; }
interface Establishment { id: string; name: string; code: string | null; is_active: boolean; }
interface Department { id: string; name: string; code: string | null; establishment_id: string | null; is_active: boolean; }
// One row = one post (a role of a person, with its place and designation).
interface SignUser { id: string; user_id: string; email: string; full_name: string; role: string; role_label: string; establishment_name: string | null; department_name: string | null; designation: string | null; can_sign: boolean; }
const signPostLine = (u: SignUser) => [u.role_label, u.designation, u.establishment_name, u.department_name].filter(Boolean).join(" · ");
interface AdminUser { id: string; email: string; full_name: string; active_role: string | null; designation: string | null; }

type Tab = "users" | "roles" | "projects" | "establishments" | "departments" | "categories" | "priorities" | "signatures" | "multi" | "foc";

const INPUT = "w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]";
const LABEL = "block text-sm font-semibold text-gray-600 mb-1";

function Row({ name, sub, active, onToggle, onDelete, onEdit }: { name: string; sub?: string; active: boolean; onToggle: () => void; onDelete: () => void; onEdit?: () => void }) {
  async function handleDelete() {
    const confirmed = await confirmAction({
      title: "Delete this item?",
      text: `"${name}" will be permanently deleted. This cannot be undone.`,
      confirmText: "Delete",
      danger: true,
    });
    if (confirmed) onDelete();
  }
  return (
    <div className={`flex items-center justify-between px-4 py-3 rounded-lg border mb-2 ${active ? "bg-white border-gray-200" : "bg-gray-50 border-gray-100 opacity-60"}`}>
      <div className="min-w-0 flex-1">
        <p className="text-base font-semibold text-gray-900 truncate">{name}</p>
        {sub && <p className="text-sm text-gray-500 truncate">{sub}</p>}
        {!active && <span className="text-xs text-amber-600 font-medium">Hidden</span>}
      </div>
      <div className="flex gap-1 ml-3 shrink-0">
        {onEdit && (
          <button onClick={onEdit} title="Edit (fix a spelling)" className="p-2 rounded-lg hover:bg-[#F0F7F7] text-gray-400 hover:text-[#0D6E6E]">
            <Pencil size={16} />
          </button>
        )}
        <button onClick={onToggle} title={active ? "Hide" : "Show"} className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
          {active ? <Eye size={16} /> : <EyeOff size={16} />}
        </button>
        <button onClick={handleDelete} title="Delete" className="p-2 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500">
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}

/** Edit one text value (category name, priority label). */
function EditFieldModal({ title, label, hint, value, onSave, onClose }: {
  title: string; label: string; hint?: string; value: string; onSave: (v: string) => Promise<void>; onClose: () => void;
}) {
  const [v, setV] = useState(value);
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try { await onSave(v.trim()); onClose(); }
    catch (err) { toast.error(apiErrorDetail(err) ?? "Could not save."); }
    finally { setSaving(false); }
  }
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="px-6 py-5 space-y-2">
          {hint && <p className="text-xs text-gray-500">{hint}</p>}
          <label className={LABEL}>{label} *</label>
          <input value={v} onChange={(e) => setV(e.target.value)} className={INPUT} autoFocus
            onKeyDown={(e) => { if (e.key === "Enter" && v.trim() && v.trim() !== value) void save(); }} />
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2.5 rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-100">Cancel</button>
          <button onClick={save} disabled={saving || !v.trim() || v.trim() === value}
            className="flex items-center gap-1.5 px-5 py-2.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-semibold hover:bg-[#178F8F] disabled:opacity-50">
            {saving && <Loader2 size={15} className="animate-spin" />} Save
          </button>
        </div>
      </div>
    </div>
  );
}

export function AdminPanel() {
  const [tab, setTab] = useState<Tab>("users");
  const qc = useQueryClient();
  const [newEst, setNewEst] = useState({ name: "", code: "" });
  const [newCat, setNewCat] = useState({ name: "" });
  const [newPri, setNewPri] = useState({ name: "", label: "" });

  const [signGrantUserId, setSignGrantUserId] = useState("");
  // Edit pop-ups (fix spellings) and "Add department" from an establishment's box.
  const [editEst, setEditEst] = useState<Establishment | null>(null);
  const [editDept, setEditDept] = useState<Department | null>(null);
  const [addDeptFor, setAddDeptFor] = useState<Establishment | null>(null);
  // Establishment boxes whose department list is open.
  const [openEst, setOpenEst] = useState<string[]>([]);
  const toggleOpenEst = (id: string) => setOpenEst((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));
  const DEPT_KEYS = ["admin-departments-all", "admin-department-names", "departments"];
  async function deleteDept(d: Department, estName: string) {
    if (!(await confirmAction({
      title: "Delete this department?",
      text: `"${d.name}" will be removed from ${estName} only. A department that people or files still use is not removed — you will see why.`,
      confirmText: "Delete", danger: true,
    }))) return;
    try {
      const r = await api.post("/admin/departments/remove", { ids: [d.id] });
      const res = r.data as { removed: number; results: { status: string; reasons: string[] }[] };
      DEPT_KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      if (res.removed) showSuccess(`“${d.name}” deleted from ${estName}.`);
      else await showBlocked(`“${d.name}” was not deleted:\n${(res.results[0]?.reasons ?? []).map((x) => `• ${x}`).join("\n")}\nYou can hide it instead (the eye button) — that keeps everything intact.`);
    } catch (err) {
      toast.error(apiErrorDetail(err) ?? "Could not delete the department.");
    }
  }
  const [editCat, setEditCat] = useState<Item | null>(null);
  const [editPri, setEditPri] = useState<Item | null>(null);

  const { data: establishments = [] } = useQuery<Establishment[]>({ queryKey: ["admin-establishments-all"], queryFn: async () => (await api.get("/admin/establishments/all")).data });
  const { data: allDepartments = [] } = useQuery<Department[]>({ queryKey: ["admin-departments-all"], queryFn: async () => (await api.get("/admin/departments/all")).data });
  const { data: categories = [] } = useQuery<Item[]>({ queryKey: ["admin-categories"], queryFn: async () => (await api.get("/admin/categories")).data });
  const { data: priorities = [] } = useQuery<Item[]>({ queryKey: ["admin-priorities"], queryFn: async () => (await api.get("/admin/priorities")).data });
  const { data: signUsers = [] } = useQuery<SignUser[]>({ queryKey: ["sign-permissions"], queryFn: async () => (await api.get("/admin/sign-permissions")).data });
  const { data: signCandidates = [] } = useQuery<SignUser[]>({ queryKey: ["sign-permissions", "candidates"], queryFn: async () => (await api.get("/admin/sign-permissions/candidates")).data, enabled: tab === "signatures" });

  async function act(keys: string | string[], fn: () => Promise<unknown>) {
    try {
      await fn();
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      showSuccess("Done");
    } catch (err: unknown) {
      const msg = apiErrorDetail(err);
      // A refused delete explains itself over several lines — show it as a
      // dialog the user can read, not a toast that disappears.
      if (msg && msg.includes("\n")) await showBlocked(msg);
      else toast.error(msg ?? "Action failed");
    }
  }

  const TABS: { id: Tab; label: string; icon: React.ElementType; badge?: number }[] = [
    { id: "users",          label: "User Management", icon: Users },
    { id: "roles",          label: "Roles",           icon: ShieldCheck },
    { id: "projects",       label: "Projects",        icon: FolderKanban },
    { id: "establishments", label: "Establishments", icon: Building2 },
    { id: "departments",    label: "Departments",    icon: Layers },
    { id: "categories",     label: "Categories",     icon: Tag },
    { id: "priorities",     label: "Priorities",     icon: AlertTriangle },
    { id: "signatures",     label: "Signatures",     icon: PenLine },
    { id: "multi",          label: "Multiple designations", icon: Copy },
    // FOC (Fixation of Ceiling): projects, FOC sheets and officers.
    ...(FOC_ENABLED ? [{ id: "foc" as const, label: "FOC", icon: Landmark }] : []),
  ];

  return (
    <div className="px-[15px] py-6">
      <div className="mb-5">
        <h1 className="text-xl font-bold text-[#1A1A2E] flex items-center gap-2">
          <ShieldCheck size={20} className="text-[#0D6E6E] shrink-0" /> Admin Panel
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">Manage users and all system dropdown options.</p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-200 mb-6 overflow-x-auto">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-semibold whitespace-nowrap border-b-2 transition-colors shrink-0 ${tab === t.id ? "border-[#0D6E6E] text-[#0D6E6E]" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
            <t.icon size={15} /> {t.label}
            {t.badge ? <span className="bg-red-500 text-white text-xs px-1.5 py-0.5 rounded-full font-bold">{t.badge}</span> : null}
          </button>
        ))}
      </div>

      {/* ── USER MANAGEMENT ── */}
      {tab === "users" && <UserManagementSection />}
      {FOC_ENABLED && tab === "foc" && <FocAdminPage embedded />}

      {/* ── ROLE MANAGEMENT ── */}
      {tab === "roles" && <RoleManagementSection />}

      {/* ── PROJECTS ── */}
      {tab === "projects" && <ProjectManagementSection />}

      {/* ── ESTABLISHMENTS ── */}
      {tab === "establishments" && (
        <div>
          <div className="bg-gray-50 rounded-xl border border-gray-200 p-4 mb-5">
            <p className="text-sm font-semibold text-gray-700 mb-3">Add Establishment</p>
            <div className="flex gap-3 items-end">
              <div className="flex-1"><label className={LABEL}>Name *</label><input value={newEst.name} onChange={(e) => setNewEst((s) => ({ ...s, name: e.target.value }))} placeholder="e.g. Main Campus" className={INPUT} /></div>
              <div className="w-36"><label className={LABEL}>Code *</label><input value={newEst.code} onChange={(e) => setNewEst((s) => ({ ...s, code: e.target.value }))} placeholder="e.g. MAIN" className={INPUT} /></div>
              <button onClick={() => act(["admin-establishments-all","establishments"], async () => { await api.post("/admin/establishments", newEst); setNewEst({ name: "", code: "" }); })} disabled={!newEst.name.trim() || !newEst.code.trim()}
                className="flex items-center gap-1 px-4 py-2.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-semibold hover:bg-[#178F8F] disabled:opacity-50 whitespace-nowrap">
                <Plus size={15} /> Add
              </button>
            </div>
          </div>
          {establishments.map((e) => {
            const depts = allDepartments.filter((d) => d.establishment_id === e.id).sort((a, b) => a.name.localeCompare(b.name));
            const EST_KEYS = ["admin-establishments-all", "establishments"];
            return (
              <div key={e.id} className={`rounded-xl border mb-3 overflow-hidden ${e.is_active ? "bg-white border-gray-200" : "bg-gray-50 border-gray-100 opacity-70"}`}>
                <div className="flex flex-wrap items-center gap-3 px-4 py-3 bg-gray-50 border-b border-gray-100">
                  <div className="min-w-0 flex-1">
                    <p className="text-base font-semibold text-gray-900 truncate">{e.name}</p>
                    <p className="text-sm text-gray-500">
                      {e.code ? `Code: ${e.code}` : "No code"} · {depts.length} department{depts.length === 1 ? "" : "s"}
                      {!e.is_active && <span className="ml-2 text-xs text-amber-600 font-medium">Hidden</span>}
                    </p>
                  </div>
                  <button onClick={() => setAddDeptFor(e)}
                    className="flex items-center gap-1 px-3 py-2 bg-[#0D6E6E] text-white rounded-lg text-sm font-semibold hover:bg-[#178F8F]"><Plus size={14} /> Add department</button>
                  <button onClick={() => setEditEst(e)} title="Edit name or code" className="p-2 rounded-lg hover:bg-[#F0F7F7] text-gray-400 hover:text-[#0D6E6E]"><Pencil size={16} /></button>
                  <button onClick={() => act(EST_KEYS, () => api.patch(`/admin/establishments/${e.id}/toggle`, {}))} title={e.is_active ? "Hide" : "Show"}
                    className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">{e.is_active ? <Eye size={16} /> : <EyeOff size={16} />}</button>
                  <button onClick={async () => {
                    if (await confirmAction({ title: "Delete this establishment?", text: `"${e.name}" will be permanently deleted. This cannot be undone.`, confirmText: "Delete", danger: true }))
                      await act(EST_KEYS, () => api.delete(`/admin/establishments/${e.id}`));
                  }} title="Delete" className="p-2 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500"><Trash2 size={16} /></button>
                </div>
                <div className="px-4 py-2.5">
                  {depts.length === 0 ? (
                    <p className="text-sm text-gray-400">No departments yet — use “Add department”.</p>
                  ) : (
                    <button type="button" onClick={() => toggleOpenEst(e.id)}
                      className="flex items-center gap-1.5 text-sm font-semibold text-[#0D6E6E] hover:underline">
                      {openEst.includes(e.id) ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                      {openEst.includes(e.id) ? "Hide departments" : `Show departments (${depts.length})`}
                    </button>
                  )}
                  {openEst.includes(e.id) && depts.length > 0 && (
                    <div className="mt-2 border border-gray-100 rounded-lg divide-y divide-gray-100">
                      {depts.map((d) => (
                        <div key={d.id} className={`flex items-center gap-3 px-3 py-2 ${d.is_active ? "" : "bg-gray-50"}`}>
                          <div className="min-w-0 flex-1">
                            <span className={`text-sm font-medium ${d.is_active ? "text-gray-900" : "text-gray-400"}`}>{d.name}</span>
                            {!d.is_active && <span className="ml-2 text-xs text-amber-600 font-medium">Hidden</span>}
                          </div>
                          <span className="text-xs font-mono font-semibold text-[#0A5757] bg-[#E6F4F4] border border-[#BFDEDB] rounded px-1.5 py-0.5">{d.code ?? "—"}</span>
                          <button onClick={() => setEditDept(d)} title="Edit name or code" className="p-1.5 rounded-lg hover:bg-[#F0F7F7] text-gray-400 hover:text-[#0D6E6E]"><Pencil size={15} /></button>
                          <button onClick={() => act(DEPT_KEYS, () => api.patch(`/admin/departments/${d.id}/toggle`, {}))} title={d.is_active ? "Hide this department" : "Show this department"}
                            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">{d.is_active ? <Eye size={15} /> : <EyeOff size={15} />}</button>
                          <button onClick={() => deleteDept(d, e.name)} title={`Delete from ${e.name}`}
                            className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500"><Trash2 size={15} /></button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── MULTIPLE DESIGNATIONS ── */}
      {tab === "multi" && <MultiDesignationSection />}

      {/* ── DEPARTMENTS ── */}
      {tab === "departments" && <DepartmentManagementSection />}

      {/* ── CATEGORIES ── */}
      {tab === "categories" && (
        <div>
          <div className="bg-gray-50 rounded-xl border border-gray-200 p-4 mb-5">
            <p className="text-sm font-semibold text-gray-700 mb-3">Add Category</p>
            <div className="flex gap-3 items-end">
              <div className="flex-1"><label className={LABEL}>Category Name *</label><input value={newCat.name} onChange={(e) => setNewCat({ name: e.target.value })} placeholder="e.g. Finance & Budget" className={INPUT} /></div>
              <button onClick={() => act("admin-categories", async () => { await api.post("/admin/categories", newCat); setNewCat({ name: "" }); })} disabled={!newCat.name}
                className="flex items-center gap-1 px-4 py-2.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-semibold hover:bg-[#178F8F] disabled:opacity-50 whitespace-nowrap">
                <Plus size={15} /> Add
              </button>
            </div>
          </div>
          {categories.map((c) => <Row key={c.id} name={c.name} active={c.is_active} onEdit={() => setEditCat(c)} onToggle={() => act("admin-categories", () => api.patch(`/admin/categories/${c.id}/toggle`, {}))} onDelete={() => act("admin-categories", () => api.delete(`/admin/categories/${c.id}`))} />)}
        </div>
      )}

      {/* ── PRIORITIES ── */}
      {tab === "priorities" && (
        <div>
          <div className="bg-gray-50 rounded-xl border border-gray-200 p-4 mb-5">
            <p className="text-sm font-semibold text-gray-700 mb-3">Add Priority</p>
            <div className="flex gap-3 items-end">
              <div className="w-40"><label className={LABEL}>System Key *</label><input value={newPri.name} onChange={(e) => setNewPri((s) => ({ ...s, name: e.target.value }))} placeholder="e.g. urgent" className={INPUT} /></div>
              <div className="flex-1"><label className={LABEL}>Display Label *</label><input value={newPri.label} onChange={(e) => setNewPri((s) => ({ ...s, label: e.target.value }))} placeholder="e.g. Urgent" className={INPUT} /></div>
              <button onClick={() => act("admin-priorities", async () => { await api.post("/admin/priorities", newPri); setNewPri({ name: "", label: "" }); })} disabled={!newPri.name || !newPri.label}
                className="flex items-center gap-1 px-4 py-2.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-semibold hover:bg-[#178F8F] disabled:opacity-50 whitespace-nowrap">
                <Plus size={15} /> Add
              </button>
            </div>
          </div>
          {priorities.map((p) => <Row key={p.id} name={p.label ?? p.name} sub={`Key: ${p.name}`} active={p.is_active} onEdit={() => setEditPri(p)} onToggle={() => act("admin-priorities", () => api.patch(`/admin/priorities/${p.id}/toggle`, {}))} onDelete={() => act("admin-priorities", () => api.delete(`/admin/priorities/${p.id}`))} />)}
        </div>
      )}

      {/* Edit / add pop-ups */}
      {editEst && (
        <EditNameCodeModal title="Edit establishment" name={editEst.name} code={editEst.code}
          hint="Fix the name or code. Everything is linked to the establishment itself, so nothing else has to change."
          onSave={async (name, code) => { await api.patch(`/admin/establishments/${editEst.id}`, { name, code }); ["admin-establishments-all", "establishments"].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); showSuccess("Establishment updated."); }}
          onClose={() => setEditEst(null)} />
      )}
      {editDept && (
        <EditNameCodeModal title="Edit department" name={editDept.name} code={editDept.code}
          hint="A new code is used for new file numbers; existing file numbers stay as they are."
          onSave={async (name, code) => { await api.patch(`/admin/departments/${editDept.id}`, { name, code }); ["admin-departments-all", "admin-department-names", "departments"].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); showSuccess("Department updated."); }}
          onClose={() => setEditDept(null)} />
      )}
      {addDeptFor && <CreateDepartmentModal establishmentId={addDeptFor.id} establishmentName={addDeptFor.name} onClose={() => setAddDeptFor(null)} />}
      {editCat && (
        <EditFieldModal title="Edit category" label="Category name" value={editCat.name}
          hint="Files of this category are moved to the new name too."
          onSave={async (v) => { await api.patch(`/admin/categories/${editCat.id}`, { name: v }); qc.invalidateQueries({ queryKey: ["admin-categories"] }); showSuccess("Category updated."); }}
          onClose={() => setEditCat(null)} />
      )}
      {editPri && (
        <EditFieldModal title="Edit priority" label="Display label" value={editPri.label ?? editPri.name}
          hint={`Only the label people see changes. The system key “${editPri.name}” stays the same, because files and the urgent / secret handling depend on it.`}
          onSave={async (v) => { await api.patch(`/admin/priorities/${editPri.id}`, { label: v }); qc.invalidateQueries({ queryKey: ["admin-priorities"] }); showSuccess("Priority updated."); }}
          onClose={() => setEditPri(null)} />
      )}

      {/* ── SIGNATURES ── */}
      {tab === "signatures" && (
        <div className="space-y-6">
          {/* Grant permission */}
          <div className="bg-gray-50 rounded-xl border border-gray-200 p-4">
            <p className="text-sm font-semibold text-gray-700 mb-1">Grant Signature Permission</p>
            <p className="text-xs text-gray-500 mb-3">Choose the person <b>and the role</b> that may sign. Permission is given per role — a person who holds several roles signs only in the roles chosen here.</p>
            <div className="flex gap-3 items-end">
              <div className="flex-1">
                <label className={LABEL}>Select person and role *</label>
                <SearchableSelect
                  options={signCandidates.map((u) => ({
                    value: u.id,
                    label: `${u.full_name} — ${signPostLine(u)} · ${u.email}`,
                  }))}
                  value={signGrantUserId}
                  onChange={setSignGrantUserId}
                  clearable={false}
                  placeholder="Choose a person and role…"
                  searchPlaceholder="Search by name, role or email…"
                />
              </div>
              <button
                onClick={() => act("sign-permissions", async () => {
                  await api.patch(`/admin/user-roles/${signGrantUserId}/sign-permission`, { can_sign: true });
                  setSignGrantUserId("");
                })}
                disabled={!signGrantUserId}
                className="flex items-center gap-1 px-4 py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50 whitespace-nowrap"
              >
                <PenLine size={15} /> Grant Access
              </button>
            </div>
          </div>

          {/* Users with sign permission */}
          <div>
            <h2 className="text-base font-bold text-gray-800 mb-3">
              Users with Signature Permission{" "}
              {signUsers.length > 0 && (
                <span className="text-emerald-600">({signUsers.length})</span>
              )}
            </h2>
            {signUsers.length === 0 && (
              <p className="text-sm text-gray-400 py-4">No users have been granted signature permission yet.</p>
            )}
            <div className="space-y-2">
              {signUsers.map((u) => (
                <div key={u.id} className="flex items-center justify-between bg-white border border-emerald-100 rounded-xl px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-gray-900">{u.full_name}</span>
                      <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded-full text-xs font-semibold">Can Sign</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">{u.email}</p>
                    <p className="text-xs text-gray-700 mt-0.5 font-medium">{signPostLine(u)}</p>
                  </div>
                  <button
                    onClick={async () => {
                      const confirmed = await confirmAction({
                        title: "Revoke signature permission?",
                        text: `${u.full_name} will no longer be able to digitally sign documents when working as ${signPostLine(u)}.`,
                        confirmText: "Revoke",
                        danger: true,
                      });
                      if (confirmed) {
                        act("sign-permissions", () =>
                          api.patch(`/admin/user-roles/${u.id}/sign-permission`, { can_sign: false })
                        );
                      }
                    }}
                    className="flex items-center gap-1 px-3 py-1.5 border border-red-200 text-red-600 rounded-lg text-xs hover:bg-red-50 shrink-0 ml-3"
                    title="Revoke signature permission"
                  >
                    <ShieldX size={13} /> Revoke
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
