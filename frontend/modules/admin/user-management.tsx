"use client";
// Admin-created-user onboarding: Create / View / Edit / Activate-Deactivate.
// Self-registration and the Pending Approval workflow have been removed —
// every account here is created directly by an admin with a temporary
// password (see backend app/api/v1/endpoints/auth.py: POST /auth/admin/users).
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { toast } from "sonner";
import {
  Plus, Loader2, X, Copy, RefreshCw, Eye, EyeOff, Pencil,
  Power, PowerOff, ShieldAlert,
} from "lucide-react";

interface Establishment { id: string; name: string; code: string | null; is_active: boolean; }
interface Department { id: string; name: string; code: string | null; establishment_id: string | null; is_active: boolean; }

interface AdminUser {
  id: string; email: string; first_name: string | null; last_name: string | null; full_name: string;
  mobile: string | null; employee_code: string | null; date_of_birth: string | null; designation: string | null;
  establishment_id: string | null; establishment_name: string | null;
  department_id: string | null; department_name: string | null;
  active_role: string | null; is_active: boolean; must_change_password: boolean; can_sign: boolean;
}

const ROLE_OPTIONS = [
  { value: "efms_officer", label: "eFMS Officer" },
  { value: "efms_admin", label: "eFMS Admin" },
  { value: "registrar", label: "Registrar" },
  { value: "dispatch_officer", label: "Dispatch Officer" },
  { value: "hod", label: "Head of Department" },
  { value: "faculty", label: "Faculty" },
];

const INPUT = "w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]";
const LABEL = "block text-sm font-semibold text-gray-600 mb-1";

// Client-side convenience generator for the "Generate Password" button.
// The backend independently re-validates the same policy on submit, so this
// is purely a UI helper, not the source of truth for what's accepted.
function generatePassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%&*";
  const all = upper + lower + digits + symbols;
  const pick = (set: string) => set[Math.floor(Math.random() * set.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  for (let i = chars.length; i < 12; i++) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Password copied to clipboard.");
  } catch {
    toast.error("Could not copy to clipboard.");
  }
}

interface FormState {
  first_name: string; last_name: string; email: string; mobile: string;
  employee_code: string; date_of_birth: string; designation: string;
  establishment_id: string; department_id: string; role: string; is_active: boolean;
}

const EMPTY_FORM: FormState = {
  first_name: "", last_name: "", email: "", mobile: "", employee_code: "",
  date_of_birth: "", designation: "", establishment_id: "", department_id: "",
  role: "efms_officer", is_active: true,
};

function UserFields({
  form, setForm, establishments, departments, disabledEmail,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  establishments: Establishment[];
  departments: Department[];
  disabledEmail?: boolean;
}) {
  const filteredDepts = departments.filter((d) => !form.establishment_id || d.establishment_id === form.establishment_id);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div><label className={LABEL}>First Name *</label>
          <input value={form.first_name} onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))} className={INPUT} /></div>
        <div><label className={LABEL}>Last Name *</label>
          <input value={form.last_name} onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))} className={INPUT} /></div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div><label className={LABEL}>Email *</label>
          <input type="email" value={form.email} disabled={disabledEmail}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} className={`${INPUT} disabled:bg-gray-50 disabled:text-gray-500`} /></div>
        <div><label className={LABEL}>Mobile Number *</label>
          <input type="tel" value={form.mobile} onChange={(e) => setForm((f) => ({ ...f, mobile: e.target.value }))} className={INPUT} /></div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div><label className={LABEL}>Employee Code</label>
          <input value={form.employee_code} onChange={(e) => setForm((f) => ({ ...f, employee_code: e.target.value }))} className={INPUT} /></div>
        <div><label className={LABEL}>Date of Birth</label>
          <input type="date" value={form.date_of_birth} onChange={(e) => setForm((f) => ({ ...f, date_of_birth: e.target.value }))} className={INPUT} /></div>
      </div>
      <div><label className={LABEL}>Designation *</label>
        <input value={form.designation} onChange={(e) => setForm((f) => ({ ...f, designation: e.target.value }))} placeholder="e.g. Assistant Professor" className={INPUT} /></div>
      <div className="grid grid-cols-2 gap-4">
        <div><label className={LABEL}>Establishment</label>
          <select value={form.establishment_id} onChange={(e) => setForm((f) => ({ ...f, establishment_id: e.target.value, department_id: "" }))} className={INPUT}>
            <option value="">Select…</option>
            {establishments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select></div>
        <div><label className={LABEL}>Department</label>
          <select value={form.department_id} onChange={(e) => setForm((f) => ({ ...f, department_id: e.target.value }))} className={INPUT}>
            <option value="">Select…</option>
            {filteredDepts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select></div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div><label className={LABEL}>Role *</label>
          <select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))} className={INPUT}>
            {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select></div>
        <div><label className={LABEL}>Status</label>
          <select value={form.is_active ? "active" : "inactive"} onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.value === "active" }))} className={INPUT}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select></div>
      </div>
    </div>
  );
}

function CreateUserModal({ onClose, establishments, departments }: {
  onClose: () => void; establishments: Establishment[]; departments: Department[];
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  const create = useMutation({
    mutationFn: () => api.post("/auth/admin/users", {
      first_name: form.first_name, last_name: form.last_name, email: form.email,
      mobile: form.mobile, employee_code: form.employee_code || undefined,
      date_of_birth: form.date_of_birth || undefined, designation: form.designation,
      establishment_id: form.establishment_id || undefined, department_id: form.department_id || undefined,
      role: form.role, is_active: form.is_active, temp_password: password,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["user-management-users"] });
      toast.success("User created.");
      onClose();
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof msg === "string" ? msg : "Could not create user.");
      setConfirming(false);
    },
  });

  function validate(): string | null {
    if (!form.first_name || !form.last_name) return "First and last name are required.";
    if (!form.email) return "Email is required.";
    if (!form.mobile) return "Mobile number is required.";
    if (!form.designation) return "Designation is required.";
    if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
      return "Password must be at least 8 characters and include an uppercase letter, a lowercase letter and a digit.";
    }
    return null;
  }

  function handleReviewClick() {
    setError("");
    const err = validate();
    if (err) { setError(err); return; }
    setConfirming(true);
  }

  const roleLabel = ROLE_OPTIONS.find((r) => r.value === form.role)?.label ?? form.role;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-5 border-b border-gray-200 flex items-center justify-between shrink-0">
          <h3 className="text-xl font-bold text-gray-900">Create User</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>

        <div className="overflow-y-auto px-6 py-5 flex-1">
          {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">{error}</div>}

          <UserFields form={form} setForm={setForm} establishments={establishments} departments={departments} />

          <div className="mt-5 pt-5 border-t border-gray-200">
            <p className="text-sm font-semibold text-gray-700 mb-2">Account Credentials</p>
            <label className={LABEL}>Temporary Password *</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Generate or type a password"
                  className={`${INPUT} pr-11`}
                />
                <button type="button" onClick={() => setShowPassword((p) => !p)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
              <button type="button" onClick={() => { setPassword(generatePassword()); setShowPassword(true); }}
                className="flex items-center gap-1 px-3 py-2.5 border border-gray-300 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-50 whitespace-nowrap">
                <RefreshCw size={14} /> Generate
              </button>
              <button type="button" disabled={!password} onClick={() => copyToClipboard(password)}
                className="flex items-center gap-1 px-3 py-2.5 border border-gray-300 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap">
                <Copy size={14} /> Copy
              </button>
            </div>
            <p className="text-xs text-gray-400 mt-1.5">Min 8 characters, incl. uppercase, lowercase and a digit. Admin may edit before saving.</p>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3 shrink-0">
          <button onClick={onClose} className="px-4 py-2.5 rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-100">Cancel</button>
          <button onClick={handleReviewClick}
            className="flex items-center gap-1 px-5 py-2.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-semibold hover:bg-[#178F8F]">
            <Plus size={15} /> Create User
          </button>
        </div>
      </div>

      {confirming && (
        <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-6" onClick={(e) => e.stopPropagation()}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-5 border-b border-gray-200">
              <h3 className="text-xl font-bold text-gray-900">Confirm New User</h3>
            </div>
            <div className="px-6 py-5 space-y-3 max-h-[60vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div><span className="text-gray-400">Name</span><p className="font-semibold text-gray-900">{form.first_name} {form.last_name}</p></div>
                <div><span className="text-gray-400">Email</span><p className="font-semibold text-gray-900">{form.email}</p></div>
                <div><span className="text-gray-400">Mobile</span><p className="font-semibold text-gray-900">{form.mobile}</p></div>
                <div><span className="text-gray-400">Designation</span><p className="font-semibold text-gray-900">{form.designation}</p></div>
                <div><span className="text-gray-400">Role</span><p className="font-semibold text-gray-900">{roleLabel}</p></div>
                <div><span className="text-gray-400">Status</span><p className="font-semibold text-gray-900">{form.is_active ? "Active" : "Inactive"}</p></div>
              </div>
              <div className="pt-2 border-t border-gray-100">
                <span className="text-sm text-gray-400">Temporary Password</span>
                <div className="flex items-center gap-2 mt-1">
                  <code className="font-mono text-base font-bold text-[#0D6E6E] bg-[#E6F4F4] px-3 py-1.5 rounded-lg">{password}</code>
                  <button onClick={() => copyToClipboard(password)} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500" title="Copy Password">
                    <Copy size={15} />
                  </button>
                </div>
              </div>
              <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800 flex gap-2">
                <ShieldAlert size={16} className="shrink-0 mt-0.5" />
                <span>
                  The user will sign in with their email and this temporary password, then verify an OTP.
                  They will be required to set a new password before accessing anything else.
                </span>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
              <button onClick={() => copyToClipboard(password)} className="flex items-center gap-1 px-4 py-2.5 rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-100">
                <Copy size={14} /> Copy Password
              </button>
              <button onClick={() => setConfirming(false)} className="px-4 py-2.5 rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-100">Cancel</button>
              <button onClick={() => create.mutate()} disabled={create.isPending}
                className="flex items-center gap-1 px-5 py-2.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-semibold hover:bg-[#178F8F] disabled:opacity-50">
                {create.isPending ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Create User
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EditUserModal({ user, onClose, establishments, departments }: {
  user: AdminUser; onClose: () => void; establishments: Establishment[]; departments: Department[];
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>({
    first_name: user.first_name ?? "", last_name: user.last_name ?? "", email: user.email,
    mobile: user.mobile ?? "", employee_code: user.employee_code ?? "", date_of_birth: user.date_of_birth ?? "",
    designation: user.designation ?? "", establishment_id: user.establishment_id ?? "",
    department_id: user.department_id ?? "", role: user.active_role ?? "efms_officer", is_active: user.is_active,
  });
  const [error, setError] = useState("");

  const save = useMutation({
    mutationFn: () => api.patch(`/auth/admin/users/${user.id}`, {
      first_name: form.first_name, last_name: form.last_name, email: form.email,
      mobile: form.mobile, employee_code: form.employee_code || null,
      date_of_birth: form.date_of_birth || null, designation: form.designation,
      establishment_id: form.establishment_id || null, department_id: form.department_id || null,
      role: form.role,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["user-management-users"] });
      toast.success("User updated.");
      onClose();
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(typeof msg === "string" ? msg : "Could not update user.");
    },
  });

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-5 border-b border-gray-200 flex items-center justify-between shrink-0">
          <h3 className="text-xl font-bold text-gray-900">Edit User</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>
        <div className="overflow-y-auto px-6 py-5 flex-1">
          {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">{error}</div>}
          <UserFields form={form} setForm={setForm} establishments={establishments} departments={departments} />
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3 shrink-0">
          <button onClick={onClose} className="px-4 py-2.5 rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-100">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending}
            className="flex items-center gap-1 px-5 py-2.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-semibold hover:bg-[#178F8F] disabled:opacity-50">
            {save.isPending ? <Loader2 size={15} className="animate-spin" /> : null} Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}

export function UserManagementSection() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);

  const { data: users = [], isLoading } = useQuery<AdminUser[]>({
    queryKey: ["user-management-users"],
    queryFn: async () => (await api.get("/auth/admin/users")).data,
  });
  const { data: establishments = [] } = useQuery<Establishment[]>({
    queryKey: ["admin-establishments-all"], queryFn: async () => (await api.get("/admin/establishments/all")).data,
  });
  const { data: departments = [] } = useQuery<Department[]>({
    queryKey: ["admin-departments-all"], queryFn: async () => (await api.get("/admin/departments/all")).data,
  });

  const toggleStatus = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      api.patch(`/auth/admin/users/${id}/status`, { is_active }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["user-management-users"] });
      toast.success("User status updated.");
    },
    onError: () => toast.error("Could not update user status."),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-gray-800">Users ({users.length})</h2>
        <button onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-4 py-2.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-semibold hover:bg-[#178F8F]">
          <Plus size={15} /> Create User
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-gray-400 py-8"><Loader2 size={16} className="animate-spin" /> Loading…</div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>{["Name", "Email", "Designation", "Department", "Role", "Status", "Actions"].map((h) => (
                <th key={h} className="text-left px-4 py-3 font-semibold text-gray-600 whitespace-nowrap">{h}</th>
              ))}</tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">{u.first_name} {u.last_name}</td>
                  <td className="px-4 py-3 text-gray-600 text-xs">{u.email}</td>
                  <td className="px-4 py-3 text-gray-500">{u.designation ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-500">{u.department_name ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-500 capitalize">{u.active_role?.replace(/_/g, " ") ?? "—"}</td>
                  <td className="px-4 py-3">
                    {u.is_active
                      ? <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs font-semibold">Active</span>
                      : <span className="px-2 py-0.5 bg-gray-200 text-gray-600 rounded-full text-xs font-semibold">Inactive</span>}
                    {u.must_change_password && (
                      <span className="ml-1.5 px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full text-xs font-semibold">Temp Password</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      <button onClick={() => setEditingUser(u)} title="Edit" className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
                        <Pencil size={15} />
                      </button>
                      <button
                        onClick={() => toggleStatus.mutate({ id: u.id, is_active: !u.is_active })}
                        title={u.is_active ? "Deactivate" : "Activate"}
                        className={`p-2 rounded-lg hover:bg-gray-100 ${u.is_active ? "text-gray-400 hover:text-red-500" : "text-gray-400 hover:text-green-600"}`}
                      >
                        {u.is_active ? <PowerOff size={15} /> : <Power size={15} />}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateUserModal onClose={() => setShowCreate(false)} establishments={establishments} departments={departments} />
      )}
      {editingUser && (
        <EditUserModal user={editingUser} onClose={() => setEditingUser(null)} establishments={establishments} departments={departments} />
      )}
    </div>
  );
}
