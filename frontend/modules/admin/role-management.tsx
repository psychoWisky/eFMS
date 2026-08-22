"use client";
// Super-Admin-only Role Management: list / create / edit / delete roles.
// This is a metadata/administration layer over the same role names
// User.active_role has always used on the backend — it does NOT grant any
// privilege by itself. SUPER_ADMIN's system-wide bypass is decided
// exclusively by the backend's User.is_super_admin check; nothing here can
// change that, by design (see backend app/models/user.py Role docstring).
//
// Backend enforces SUPER_ADMIN on every /auth/admin/roles endpoint
// (require_roles(SUPER_ADMIN)) — the isSuperAdmin check below is UX only,
// same convention as UserManagementSection.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { toast } from "sonner";
import { confirmAction, showSuccess } from "@/lib/alert";
import { useActiveRole } from "@/stores/auth.store";
import { Plus, Pencil, Trash2, Loader2, X, ShieldCheck, Lock } from "lucide-react";

interface RoleSummary { id: string; name: string; description: string | null; is_system: boolean; user_count: number; }

const INPUT = "w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]";
const LABEL = "block text-sm font-semibold text-gray-600 mb-1";

function roleLabelFor(name: string): string {
  return name.split("_").map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" ");
}

function RoleFormModal({ role, onClose }: { role: RoleSummary | null; onClose: () => void }) {
  const qc = useQueryClient();
  const isEdit = !!role;
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [error, setError] = useState("");

  const save = useMutation({
    mutationFn: () =>
      isEdit
        ? api.patch(`/auth/admin/roles/${role!.id}`, { name, description: description || null })
        : api.post("/auth/admin/roles", { name, description: description || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-roles"] });
      showSuccess(isEdit ? "Role updated." : "Role created.");
      onClose();
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof msg === "string" ? msg : "Could not save role.");
    },
  });

  const nameLocked = !!role?.is_system;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-5 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-xl font-bold text-gray-900">{isEdit ? "Edit Role" : "Create Role"}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {error && <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">{error}</div>}
          <div>
            <label className={LABEL}>Role Name *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={nameLocked}
              placeholder="e.g. records_clerk"
              className={`${INPUT} disabled:bg-gray-50 disabled:text-gray-500`}
            />
            {nameLocked ? (
              <p className="text-xs text-amber-600 mt-1 flex items-center gap-1"><Lock size={11} /> The Super Admin role cannot be renamed — only its description can be edited.</p>
            ) : (
              <p className="text-xs text-gray-400 mt-1">Lowercase letters, numbers and underscores only, e.g. &quot;records_clerk&quot;.</p>
            )}
          </div>
          <div>
            <label className={LABEL}>Description</label>
            <textarea
              value={description ?? ""}
              onChange={(e) => setDescription(e.target.value.slice(0, 255))}
              rows={3}
              className={`${INPUT} resize-none`}
              placeholder="What this role is for (optional)"
            />
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2.5 rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-100">Cancel</button>
          <button
            onClick={() => { setError(""); save.mutate(); }}
            disabled={save.isPending || !name.trim()}
            className="flex items-center gap-1 px-5 py-2.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-semibold hover:bg-[#178F8F] disabled:opacity-50"
          >
            {save.isPending ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} {isEdit ? "Save Changes" : "Create Role"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function RoleManagementSection() {
  const qc = useQueryClient();
  const activeRole = useActiveRole();
  const isSuperAdmin = activeRole === "super_admin";
  const [showCreate, setShowCreate] = useState(false);
  const [editingRole, setEditingRole] = useState<RoleSummary | null>(null);

  const { data: roles = [], isLoading } = useQuery<RoleSummary[]>({
    queryKey: ["admin-roles"],
    queryFn: async () => (await api.get("/auth/admin/roles")).data,
    enabled: isSuperAdmin,
  });

  const deleteRole = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/admin/roles/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-roles"] });
      showSuccess("Role deleted.");
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(typeof msg === "string" ? msg : "Could not delete role.");
    },
  });

  async function handleDelete(role: RoleSummary) {
    if (role.is_system) {
      toast.error("The Super Admin role cannot be deleted.");
      return;
    }
    if (role.user_count > 0) {
      await confirmAction({
        title: "Cannot delete this role",
        text: `Cannot delete this role because ${role.user_count} user${role.user_count === 1 ? " is" : "s are"} currently assigned to it. Reassign those users before deleting the role.`,
        confirmText: "OK",
        danger: false,
      });
      return;
    }
    const confirmed = await confirmAction({
      title: "Delete this role?",
      text: `"${roleLabelFor(role.name)}" will be permanently deleted. This cannot be undone.`,
      confirmText: "Delete",
      danger: true,
    });
    if (confirmed) deleteRole.mutate(role.id);
  }

  if (!isSuperAdmin) {
    return (
      <div className="flex items-center gap-2 text-gray-500 py-8 justify-center text-sm">
        <Lock size={16} /> Only Super Admin can access Role Management.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-gray-800">Roles ({roles.length})</h2>
        <button onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-4 py-2.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-semibold hover:bg-[#178F8F]">
          <Plus size={15} /> Create Role
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-gray-400 py-8"><Loader2 size={16} className="animate-spin" /> Loading…</div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>{["Role Name", "Description", "Users", "Type", "Actions"].map((h) => (
                <th key={h} className="text-left px-4 py-3 font-semibold text-gray-600 whitespace-nowrap">{h}</th>
              ))}</tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {roles.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">
                    <span className="flex items-center gap-1.5">
                      {r.name === "super_admin" && <ShieldCheck size={14} className="text-[#0D6E6E]" />}
                      {roleLabelFor(r.name)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{r.description ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-500">{r.user_count}</td>
                  <td className="px-4 py-3">
                    {r.is_system
                      ? <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-xs font-semibold">System</span>
                      : <span className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full text-xs font-semibold">Custom</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      <button onClick={() => setEditingRole(r)} title="Edit" className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
                        <Pencil size={15} />
                      </button>
                      <button
                        onClick={() => handleDelete(r)}
                        disabled={deleteRole.isPending || r.is_system}
                        title={r.is_system ? "The Super Admin role cannot be deleted" : "Delete"}
                        className="p-2 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-600 disabled:opacity-30 disabled:hover:bg-transparent"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && <RoleFormModal role={null} onClose={() => setShowCreate(false)} />}
      {editingRole && <RoleFormModal role={editingRole} onClose={() => setEditingRole(null)} />}
    </div>
  );
}
