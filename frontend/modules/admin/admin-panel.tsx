"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { toast } from "sonner";
import { confirmAction, showSuccess } from "@/lib/alert";
import {
  Plus, Trash2, Eye, EyeOff, Tag, Users, Building2, Layers,
  Loader2, AlertTriangle, PenLine, ShieldX, ShieldCheck,
} from "lucide-react";
import { UserManagementSection } from "./user-management";
import { RoleManagementSection } from "./role-management";

interface Item { id: string; name: string; is_active: boolean; label?: string; designation?: string; email?: string; user_id?: string; code?: string; establishment_id?: string; }
interface Establishment { id: string; name: string; code: string | null; is_active: boolean; }
interface Department { id: string; name: string; code: string | null; establishment_id: string | null; is_active: boolean; }
interface SignUser { id: string; email: string; full_name: string; designation: string | null; active_role: string | null; can_sign: boolean; }
interface AdminUser { id: string; email: string; full_name: string; active_role: string | null; designation: string | null; }

type Tab = "users" | "roles" | "establishments" | "departments" | "categories" | "priorities" | "signatures";

const INPUT = "w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]";
const LABEL = "block text-sm font-semibold text-gray-600 mb-1";

function Row({ name, sub, active, onToggle, onDelete }: { name: string; sub?: string; active: boolean; onToggle: () => void; onDelete: () => void }) {
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

export function AdminPanel() {
  const [tab, setTab] = useState<Tab>("users");
  const qc = useQueryClient();
  const [newEst, setNewEst] = useState({ name: "", code: "" });
  const [newDept, setNewDept] = useState({ name: "", code: "", establishment_id: "" });
  const [newCat, setNewCat] = useState({ name: "" });
  const [newPri, setNewPri] = useState({ name: "", label: "" });

  const [signGrantUserId, setSignGrantUserId] = useState("");

  const { data: establishments = [] } = useQuery<Establishment[]>({ queryKey: ["admin-establishments-all"], queryFn: async () => (await api.get("/admin/establishments/all")).data });
  const { data: departments = [] } = useQuery<Department[]>({ queryKey: ["admin-departments-all"], queryFn: async () => (await api.get("/admin/departments/all")).data });
  const { data: categories = [] } = useQuery<Item[]>({ queryKey: ["admin-categories"], queryFn: async () => (await api.get("/admin/categories")).data });
  const { data: priorities = [] } = useQuery<Item[]>({ queryKey: ["admin-priorities"], queryFn: async () => (await api.get("/admin/priorities")).data });
  const { data: signUsers = [] } = useQuery<SignUser[]>({ queryKey: ["sign-permissions"], queryFn: async () => (await api.get("/admin/sign-permissions")).data });
  const { data: adminUsers = [] } = useQuery<AdminUser[]>({ queryKey: ["admin-users"], queryFn: async () => (await api.get("/admin/users")).data });

  async function act(keys: string | string[], fn: () => Promise<unknown>) {
    try {
      await fn();
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      showSuccess("Done");
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(msg ?? "Action failed");
    }
  }

  const TABS: { id: Tab; label: string; icon: React.ElementType; badge?: number }[] = [
    { id: "users",          label: "User Management", icon: Users },
    { id: "roles",          label: "Roles",           icon: ShieldCheck },
    { id: "establishments", label: "Establishments", icon: Building2 },
    { id: "departments",    label: "Departments",    icon: Layers },
    { id: "categories",     label: "Categories",     icon: Tag },
    { id: "priorities",     label: "Priorities",     icon: AlertTriangle },
    { id: "signatures",     label: "Signatures",     icon: PenLine },
  ];

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1A1A2E]">Admin Panel</h1>
        <p className="text-base text-gray-500 mt-1">Manage users and all system dropdown options.</p>
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

      {/* ── ROLE MANAGEMENT ── */}
      {tab === "roles" && <RoleManagementSection />}

      {/* ── ESTABLISHMENTS ── */}
      {tab === "establishments" && (
        <div>
          <div className="bg-gray-50 rounded-xl border border-gray-200 p-4 mb-5">
            <p className="text-sm font-semibold text-gray-700 mb-3">Add Establishment</p>
            <div className="flex gap-3 items-end">
              <div className="flex-1"><label className={LABEL}>Name *</label><input value={newEst.name} onChange={(e) => setNewEst((s) => ({ ...s, name: e.target.value }))} placeholder="e.g. Main Campus" className={INPUT} /></div>
              <div className="w-36"><label className={LABEL}>Code</label><input value={newEst.code} onChange={(e) => setNewEst((s) => ({ ...s, code: e.target.value }))} placeholder="e.g. MAIN" className={INPUT} /></div>
              <button onClick={() => act(["admin-establishments-all","establishments"], async () => { await api.post("/admin/establishments", newEst); setNewEst({ name: "", code: "" }); })} disabled={!newEst.name}
                className="flex items-center gap-1 px-4 py-2.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-semibold hover:bg-[#178F8F] disabled:opacity-50 whitespace-nowrap">
                <Plus size={15} /> Add
              </button>
            </div>
          </div>
          {establishments.map((e) => <Row key={e.id} name={e.name} sub={e.code ? `Code: ${e.code}` : undefined} active={e.is_active} onToggle={() => act(["admin-establishments-all","establishments"], () => api.patch(`/admin/establishments/${e.id}/toggle`, {}))} onDelete={() => act(["admin-establishments-all","establishments"], () => api.delete(`/admin/establishments/${e.id}`))} />)}
        </div>
      )}

      {/* ── DEPARTMENTS ── */}
      {tab === "departments" && (
        <div>
          <div className="bg-gray-50 rounded-xl border border-gray-200 p-4 mb-5">
            <p className="text-sm font-semibold text-gray-700 mb-3">Add Department</p>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div><label className={LABEL}>Name *</label><input value={newDept.name} onChange={(e) => setNewDept((s) => ({ ...s, name: e.target.value }))} placeholder="e.g. Agronomy" className={INPUT} /></div>
              <div><label className={LABEL}>Code (4 letters, used in file ref)</label><input value={newDept.code} onChange={(e) => setNewDept((s) => ({ ...s, code: e.target.value.toUpperCase().slice(0,4) }))} placeholder="e.g. AGRO" className={INPUT} /></div>
            </div>
            <div className="flex gap-3 items-end">
              <div className="flex-1"><label className={LABEL}>Establishment *</label>
                <select value={newDept.establishment_id} onChange={(e) => setNewDept((s) => ({ ...s, establishment_id: e.target.value }))} className={INPUT}>
                  <option value="">Select…</option>{establishments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </div>
              <button onClick={() => act(["admin-departments-all","departments"], async () => { await api.post("/admin/departments", newDept); setNewDept({ name: "", code: "", establishment_id: "" }); })} disabled={!newDept.name}
                className="flex items-center gap-1 px-4 py-2.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-semibold hover:bg-[#178F8F] disabled:opacity-50 whitespace-nowrap">
                <Plus size={15} /> Add
              </button>
            </div>
          </div>
          {departments.map((d) => { const est = establishments.find((e) => e.id === d.establishment_id); return <Row key={d.id} name={d.name} sub={[est?.name, d.code ? `Code: ${d.code}` : ""].filter(Boolean).join(" · ")} active={d.is_active} onToggle={() => act(["admin-departments-all","departments"], () => api.patch(`/admin/departments/${d.id}/toggle`, {}))} onDelete={() => act(["admin-departments-all","departments"], () => api.delete(`/admin/departments/${d.id}`))} />; })}
        </div>
      )}

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
          {categories.map((c) => <Row key={c.id} name={c.name} active={c.is_active} onToggle={() => act("admin-categories", () => api.patch(`/admin/categories/${c.id}/toggle`, {}))} onDelete={() => act("admin-categories", () => api.delete(`/admin/categories/${c.id}`))} />)}
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
          {priorities.map((p) => <Row key={p.id} name={p.label ?? p.name} sub={`Key: ${p.name}`} active={p.is_active} onToggle={() => act("admin-priorities", () => api.patch(`/admin/priorities/${p.id}/toggle`, {}))} onDelete={() => act("admin-priorities", () => api.delete(`/admin/priorities/${p.id}`))} />)}
        </div>
      )}

      {/* ── SIGNATURES ── */}
      {tab === "signatures" && (
        <div className="space-y-6">
          {/* Grant permission */}
          <div className="bg-gray-50 rounded-xl border border-gray-200 p-4">
            <p className="text-sm font-semibold text-gray-700 mb-1">Grant Signature Permission</p>
            <p className="text-xs text-gray-500 mb-3">Select any user to allow them to digitally sign documents forwarded to them.</p>
            <div className="flex gap-3 items-end">
              <div className="flex-1">
                <label className={LABEL}>Select User *</label>
                <select
                  value={signGrantUserId}
                  onChange={(e) => setSignGrantUserId(e.target.value)}
                  className={INPUT}
                >
                  <option value="">Choose a user…</option>
                  {adminUsers
                    .filter((u) => !signUsers.some((s) => s.id === u.id))
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.full_name} — {u.designation ?? u.active_role ?? "No role"} · {u.email}
                      </option>
                    ))}
                </select>
              </div>
              <button
                onClick={() => act("sign-permissions", async () => {
                  await api.patch(`/admin/users/${signGrantUserId}/sign-permission`, { can_sign: true });
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
                    <p className="text-xs text-gray-500 mt-0.5">{u.email} · {u.designation ?? "—"} · {u.active_role?.replace(/_/g, " ") ?? "—"}</p>
                  </div>
                  <button
                    onClick={async () => {
                      const confirmed = await confirmAction({
                        title: "Revoke signature permission?",
                        text: `${u.full_name} will no longer be able to digitally sign documents.`,
                        confirmText: "Revoke",
                        danger: true,
                      });
                      if (confirmed) {
                        act("sign-permissions", () =>
                          api.patch(`/admin/users/${u.id}/sign-permission`, { can_sign: false })
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
