"use client";
// Admin-created-user onboarding: Create / View / Edit / Activate-Deactivate.
// Self-registration and the Pending Approval workflow have been removed —
// every account here is created directly by an admin with a temporary
// password (see backend app/api/v1/endpoints/auth.py: POST /auth/admin/users).
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { toast } from "sonner";
import { showSuccess } from "@/lib/alert";
import { useActiveRole } from "@/stores/auth.store";
import {
  Plus, Loader2, X, Copy, RefreshCw, Eye, EyeOff, Pencil, KeyRound,
  Power, PowerOff, ShieldAlert, Upload, Download, CheckCircle2, XCircle, ClipboardCopy, ArrowRightLeft,
} from "lucide-react";
import { SearchableSelect } from "@/components/shared/searchable-select";
import { paginate, TablePagination } from "@/components/shared/table-pagination";
import { useTableSearchSort, TableSearchInput, SortTh } from "@/components/shared/table-controls";

interface Establishment { id: string; name: string; code: string | null; is_active: boolean; }
interface Department { id: string; name: string; code: string | null; establishment_id: string | null; is_active: boolean; }

interface AdminUser {
  id: string; email: string; first_name: string | null; middle_name: string | null; last_name: string | null; full_name: string;
  mobile: string | null; employee_code: string | null; date_of_birth: string | null; designation: string | null;
  establishment_id: string | null; establishment_name: string | null;
  department_id: string | null; department_name: string | null;
  active_role: string | null;
  roles?: {
    id?: string;
    role: string;
    department_id: string | null;
    department_name?: string | null;
    establishment_id: string | null;
    establishment_name?: string | null;
  }[];
  is_active: boolean; must_change_password: boolean; can_sign: boolean;
  deactivation_reason_type: string | null; deactivation_remarks: string | null;
  deactivated_at: string | null; deactivated_by: string | null;
}

type StatusFilter = "all" | "active" | "inactive";

const adminUserRowText = (u: AdminUser) =>
  [u.full_name, u.email, u.designation, u.department_name, u.establishment_name,
   u.employee_code, u.mobile, u.active_role?.replace(/_/g, " "), u.is_active ? "active" : "inactive"]
    .filter(Boolean).join(" ");
const adminUserSortValue = (u: AdminUser, key: string): string | number | null => {
  switch (key) {
    case "name": return u.full_name;
    case "email": return u.email;
    case "designation": return u.designation ?? "";
    case "department": return u.department_name ?? "";
    case "role": return u.active_role ?? "";
    case "status": return u.is_active ? "active" : "inactive";
    default: return null;
  }
};

const DEACTIVATION_REASON_OPTIONS = [
  { value: "retired", label: "Retired" },
  { value: "transferred", label: "Transferred" },
  { value: "resigned", label: "Resigned" },
  { value: "left_organization", label: "Left Organization" },
  { value: "suspended", label: "Suspended" },
  { value: "other", label: "Other" },
];

// Fixed system roles assignable to eFMS users — mirrors backend
// EFMS_ASSIGNABLE_ROLES (app/models/user.py) — keep in sync. Any *custom*
// (non-system) role from GET /auth/admin/roles is always assignable — see
// buildRoleOptions below, which combines this allow-list (for system roles)
// with every custom role Super Admin has created.
const ASSIGNABLE_SYSTEM_ROLE_NAMES = new Set([
  "super_admin", "admin", "efms_officer", "efms_admin",
  "registrar", "dispatch_officer", "hod", "faculty",
]);
const SYSTEM_ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin", admin: "Admin", efms_officer: "eFMS Officer",
  efms_admin: "eFMS Admin", registrar: "Registrar", dispatch_officer: "Dispatch Officer",
  hod: "Head of Department", faculty: "Faculty",
};

interface RoleSummary { id: string; name: string; description: string | null; is_system: boolean; user_count: number; }

function roleLabelFor(name: string): string {
  return SYSTEM_ROLE_LABELS[name] ?? name.split("_").map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" ");
}

function buildRoleOptions(roles: RoleSummary[]): { value: string; label: string }[] {
  return roles
    .filter((r) => (r.is_system ? ASSIGNABLE_SYSTEM_ROLE_NAMES.has(r.name) : true))
    .map((r) => ({ value: r.name, label: roleLabelFor(r.name) }));
}

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

async function copyToClipboard(text: string, message = "Password copied to clipboard.") {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(message);
  } catch {
    toast.error("Could not copy to clipboard.");
  }
}

interface FormState {
  first_name: string; middle_name: string; last_name: string; email: string; mobile: string;
  employee_code: string; date_of_birth: string; designation: string;
  establishment_id: string; department_id: string; role: string; is_active: boolean;
}

const EMPTY_FORM: FormState = {
  first_name: "", middle_name: "", last_name: "", email: "", mobile: "", employee_code: "",
  date_of_birth: "", designation: "", establishment_id: "", department_id: "",
  role: "efms_officer", is_active: true,
};

function UserFields({
  form, setForm, establishments, departments, roleOptions, disabledEmail,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  establishments: Establishment[];
  departments: Department[];
  roleOptions: { value: string; label: string }[];
  disabledEmail?: boolean;
}) {
  const filteredDepts = departments.filter((d) => !form.establishment_id || d.establishment_id === form.establishment_id);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <div><label className={LABEL}>First Name *</label>
          <input value={form.first_name} onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))} className={INPUT} /></div>
        <div><label className={LABEL}>Middle Name</label>
          <input value={form.middle_name} onChange={(e) => setForm((f) => ({ ...f, middle_name: e.target.value }))} className={INPUT} /></div>
        <div><label className={LABEL}>Last Name *</label>
          <input value={form.last_name} onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))} className={INPUT} /></div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div><label className={LABEL}>Email *</label>
          <input type="email" value={form.email} disabled={disabledEmail}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} className={`${INPUT} disabled:bg-gray-50 disabled:text-gray-500`} /></div>
        <div><label className={LABEL}>Mobile Number</label>
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
          <SearchableSelect
            options={establishments.map((e) => ({ value: e.id, label: e.name }))}
            value={form.establishment_id}
            onChange={(v) => setForm((f) => ({ ...f, establishment_id: v, department_id: "" }))}
            placeholder="Select…"
            searchPlaceholder="Search establishments…"
          /></div>
        <div><label className={LABEL}>Department</label>
          <SearchableSelect
            options={filteredDepts.map((d) => ({ value: d.id, label: d.name }))}
            value={form.department_id}
            onChange={(v) => setForm((f) => ({ ...f, department_id: v }))}
            placeholder="Select…"
            searchPlaceholder="Search departments…"
          /></div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div><label className={LABEL}>Role *</label>
          <SearchableSelect
            options={roleOptions.map((r) => ({ value: r.value, label: r.label }))}
            value={form.role}
            onChange={(v) => setForm((f) => ({ ...f, role: v }))}
            clearable={false}
            placeholder="Select role…"
            searchPlaceholder="Search roles…"
          /></div>
        <div><label className={LABEL}>Status</label>
          <select value={form.is_active ? "active" : "inactive"} onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.value === "active" }))} className={INPUT}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select></div>
      </div>
    </div>
  );
}

function CreateUserModal({ onClose, establishments, departments, roleOptions }: {
  onClose: () => void; establishments: Establishment[]; departments: Department[]; roleOptions: { value: string; label: string }[];
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const create = useMutation({
    mutationFn: () => api.post("/auth/admin/users", {
      first_name: form.first_name, middle_name: form.middle_name || undefined, last_name: form.last_name, email: form.email,
      mobile: form.mobile, employee_code: form.employee_code || undefined,
      date_of_birth: form.date_of_birth || undefined, designation: form.designation,
      establishment_id: form.establishment_id || undefined, department_id: form.department_id || undefined,
      role: form.role, is_active: form.is_active, temp_password: password,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["user-management-users"] });
      showSuccess("User created.");
      onClose();
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail || (err as Error)?.message;
      toast.error(typeof msg === "string" ? msg : "Could not create user.");
      setConfirming(false);
    },
  });

  function validate(): string | null {
    if (!form.first_name || !form.last_name) return "First and last name are required.";
    if (!form.email) return "Email is required.";
    if (form.mobile && !/^\+?[0-9\s-]{10,15}$/.test(form.mobile.trim())) {
      return "Mobile number must be 10-15 digits, optional plus sign, spaces and dashes allowed.";
    }
    if (!form.designation) return "Designation is required.";
    if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
      return "Password must be at least 8 characters and include an uppercase letter, a lowercase letter and a digit.";
    }
    return null;
  }

  function handleReviewClick() {
    const err = validate();
    if (err) {
      toast.error(err);
      return;
    }
    setConfirming(true);
  }

  const roleLabel = roleOptions.find((r) => r.value === form.role)?.label ?? form.role;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-5 border-b border-gray-200 flex items-center justify-between shrink-0">
          <h3 className="text-xl font-bold text-gray-900">Create User</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>

        <div className="overflow-y-auto px-6 py-5 flex-1">
          <UserFields form={form} setForm={setForm} establishments={establishments} departments={departments} roleOptions={roleOptions} />

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
                <div><span className="text-gray-400">Name</span><p className="font-semibold text-gray-900">{[form.first_name, form.middle_name, form.last_name].filter(Boolean).join(" ")}</p></div>
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

function EditUserModal({ user, onClose, establishments, departments, roleOptions }: {
  user: AdminUser; onClose: () => void; establishments: Establishment[]; departments: Department[]; roleOptions: { value: string; label: string }[];
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>({
    first_name: user.first_name ?? "", middle_name: user.middle_name ?? "", last_name: user.last_name ?? "", email: user.email,
    mobile: user.mobile ?? "", employee_code: user.employee_code ?? "", date_of_birth: user.date_of_birth ?? "",
    designation: user.designation ?? "", establishment_id: user.establishment_id ?? "",
    department_id: user.department_id ?? "", role: user.active_role ?? "efms_officer", is_active: user.is_active,
  });

  // Identify the primary role index in user.roles:
  // Match active_role and the user's current dept/establishment context; fallback to 0.
  const primaryIdx = (user.roles ?? []).findIndex(
    (r) =>
      r.role === (user.active_role ?? "") &&
      (r.department_id ?? "") === (user.department_id ?? "") &&
      (r.establishment_id ?? "") === (user.establishment_id ?? "")
  );
  const primaryIndex = primaryIdx !== -1 ? primaryIdx : 0;

  const [extraRoles, setExtraRoles] = useState<
    { role: string; department_id: string; establishment_id: string }[]
  >(
    (user.roles ?? [])
      .filter((_, idx) => idx !== primaryIndex)
      .map((r) => ({
        role: r.role,
        department_id: r.department_id ?? "",
        establishment_id: r.establishment_id ?? "",
      })),
  );
  const save = useMutation({
    mutationFn: () => {
      // Validate that any extra role row has all three fields (establishment, department, role)
      for (let i = 0; i < extraRoles.length; i++) {
        const r = extraRoles[i];
        if (r.role || r.department_id || r.establishment_id) {
          if (!r.establishment_id) throw new Error(`Role ${i + 1}: Please select an establishment.`);
          if (!r.department_id) throw new Error(`Role ${i + 1}: Please select a department.`);
          if (!r.role) throw new Error(`Role ${i + 1}: Please select a role.`);
        }
      }

      const validExtras = extraRoles.filter(
        (r) => r.role && r.department_id && r.establishment_id
      );

      // Assemble all role assignments
      const allRoles = [
        { role: form.role, department_id: form.department_id || null, establishment_id: form.establishment_id || null },
        ...validExtras.map((r) => ({
          role: r.role,
          department_id: r.department_id || null,
          establishment_id: r.establishment_id || null,
        })),
      ];

      // Validate uniqueness across (role, establishment_id, department_id)
      const seen = new Set<string>();
      for (const r of allRoles) {
        const key = `${r.role}__${r.establishment_id ?? ""}__${r.department_id ?? ""}`;
        if (seen.has(key)) {
          throw new Error("Duplicate role assignment: the same establishment, department, and role combination cannot be assigned twice.");
        }
        seen.add(key);
      }

      return api.patch(`/auth/admin/users/${user.id}`, {
        first_name: form.first_name, middle_name: form.middle_name || "", last_name: form.last_name, email: form.email,
        mobile: form.mobile, employee_code: form.employee_code || null,
        date_of_birth: form.date_of_birth || null, designation: form.designation,
        establishment_id: form.establishment_id || null, department_id: form.department_id || null,
        roles: allRoles,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["user-management-users"] });
      showSuccess("User updated.");
      onClose();
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        (err as Error)?.message;
      toast.error(typeof msg === "string" ? msg : "Could not update user.");
    },
  });

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-5 border-b border-gray-200 flex items-center justify-between shrink-0">
          <h3 className="text-xl font-bold text-gray-900">Edit User</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>
        <div className="overflow-y-auto overflow-x-hidden px-6 py-5 flex-1">
          <UserFields form={form} setForm={setForm} establishments={establishments} departments={departments} roleOptions={roleOptions} />
          <div className="mt-5 border-t border-gray-100 pt-4">
            <div className="flex items-center justify-between mb-2">
              <label className={LABEL}>
                Additional roles <span className="font-normal text-gray-400">(hierarchical: choose Establishment 1st, Department 2nd, Role 3rd)</span>
              </label>
            </div>
            <div className="space-y-3">
              {extraRoles.map((row, i) => {
                const setRow = (patch: Partial<typeof row>) =>
                  setExtraRoles((s) => s.map((r, j) => (j === i ? { ...r, ...patch } : r)));

                // Filter departments belonging to selected establishment
                const rowDepts = departments
                  .filter((d) => d.is_active !== false && (!row.establishment_id || d.establishment_id === row.establishment_id));

                // Identify roles already taken for the exact SAME establishment and department
                const takenRolesForContext = new Set<string>();
                if (row.establishment_id && row.department_id) {
                  // Primary role check
                  if (form.establishment_id === row.establishment_id && form.department_id === row.department_id && form.role) {
                    takenRolesForContext.add(form.role);
                  }
                  // Other extra role rows check
                  extraRoles.forEach((other, j) => {
                    if (
                      j !== i &&
                      other.establishment_id === row.establishment_id &&
                      other.department_id === row.department_id &&
                      other.role
                    ) {
                      takenRolesForContext.add(other.role);
                    }
                  });
                }

                const roleOpts = roleOptions.map((o) => {
                  const isTaken = takenRolesForContext.has(o.value) && o.value !== row.role;
                  return {
                    ...o,
                    label: isTaken ? `${o.label} (Already assigned)` : o.label,
                    disabled: isTaken,
                  };
                });

                return (
                  <div key={i} className="rounded-xl border border-gray-200 p-3 bg-gray-50/60">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">Additional Role {i + 1}</span>
                      <button type="button" onClick={() => setExtraRoles((s) => s.filter((_, j) => j !== i))}
                        className="text-gray-400 hover:text-red-500"><X size={15} /></button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      {/* 1st: Establishment */}
                      <div>
                        <label className="block text-xs font-semibold text-gray-500 mb-1">Establishment *</label>
                        <SearchableSelect
                          options={establishments.filter((e) => e.is_active !== false).map((e) => ({ value: e.id, label: e.name }))}
                          value={row.establishment_id}
                          onChange={(v) => setRow({ establishment_id: v, department_id: "", role: "" })}
                          placeholder="Select establishment…"
                          searchPlaceholder="Search establishments…"
                        />
                      </div>
                      {/* 2nd: Department (depends on Establishment) */}
                      <div>
                        <label className="block text-xs font-semibold text-gray-500 mb-1">Department *</label>
                        <SearchableSelect
                          options={rowDepts.map((d) => ({ value: d.id, label: d.name }))}
                          value={row.department_id}
                          disabled={!row.establishment_id}
                          onChange={(v) => setRow({ department_id: v, role: "" })}
                          placeholder={row.establishment_id ? "Select department…" : "Select establishment first"}
                          searchPlaceholder="Search departments…"
                        />
                      </div>
                      {/* 3rd: Role */}
                      <div>
                        <label className="block text-xs font-semibold text-gray-500 mb-1">Role *</label>
                        <SearchableSelect
                          options={roleOpts}
                          value={row.role}
                          disabled={!row.establishment_id || !row.department_id}
                          onChange={(v) => setRow({ role: v })}
                          clearable={false}
                          placeholder={!row.establishment_id ? "Select establishment first" : (!row.department_id ? "Select dept first" : "Select role…")}
                          searchPlaceholder="Search roles…"
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => setExtraRoles((s) => [...s, { role: "", department_id: "", establishment_id: "" }])}
              disabled={extraRoles.some((r) => !r.establishment_id || !r.department_id || !r.role)}
              className="mt-3 flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-[#0D6E6E] border border-dashed border-[#0D6E6E]/40 rounded-lg hover:bg-[#F0F7F7] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus size={15} /> Add another role
            </button>
          </div>
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


interface BulkRowResult {
  row: number; email: string | null; full_name: string | null; status: "created" | "failed";
  error: string | null; temp_password: string | null; password_generated: boolean;
}
interface BulkUploadResult { total: number; created: number; failed: number; results: BulkRowResult[]; }

async function copyAllCredentials(results: BulkRowResult[]) {
  const lines = results
    .filter((r) => r.status === "created" && r.temp_password)
    .map((r) => `${r.full_name ?? ""}\t${r.email ?? ""}\t${r.temp_password}`);
  if (lines.length === 0) {
    toast.error("No credentials to copy.");
    return;
  }
  await copyToClipboard(["Name\tEmail\tTemporary Password", ...lines].join("\n"), "All credentials copied to clipboard.");
}

// Super-Admin-only bulk import. Downloads the same sample the backend
// generates (GET /auth/admin/users/bulk/sample) via the shared `api` client
// — not a plain <a href> — since that endpoint requires a Bearer token, same
// reasoning as the Notesheet PDF download fix elsewhere in this app.
function BulkUploadModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [result, setResult] = useState<BulkUploadResult | null>(null);

  async function handleDownloadSample() {
    setDownloading(true);
    try {
      const res = await api.get("/auth/admin/users/bulk/sample", { responseType: "blob" });
      const blobUrl = URL.createObjectURL(res.data as Blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = "bulk_user_upload_sample.csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(blobUrl);
    } catch {
      toast.error("Could not download the sample CSV.");
    } finally {
      setDownloading(false);
    }
  }

  const upload = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append("file", file as File);
      const res = await api.post("/auth/admin/users/bulk", form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return res.data as BulkUploadResult;
    },
    onSuccess: (data) => {
      setResult(data);
      qc.invalidateQueries({ queryKey: ["user-management-users"] });
      if (data.failed === 0) showSuccess(`${data.created} user${data.created === 1 ? "" : "s"} created.`);
      else toast.warning(`${data.created} created, ${data.failed} failed — see details below.`);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(typeof msg === "string" ? msg : "Could not process the file.");
    },
  });

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-5 border-b border-gray-200 flex items-center justify-between shrink-0">
          <h3 className="text-xl font-bold text-gray-900">Bulk Upload Users</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>

        <div className="overflow-y-auto px-6 py-5 flex-1 space-y-5">
          <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800">
            <p>Upload a CSV file to create multiple users at once. Start from the sample template so the columns match exactly.</p>
            <button type="button" onClick={handleDownloadSample} disabled={downloading}
              className="mt-2 flex items-center gap-1.5 px-3 py-2 bg-white border border-blue-300 rounded-lg text-sm font-semibold text-blue-800 hover:bg-blue-100 disabled:opacity-50">
              {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Download Sample CSV
            </button>
          </div>

          <div>
            <label className={LABEL}>CSV File</label>
            <input type="file" accept=".csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); }}
              className="block w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-gray-100 file:text-gray-700 file:font-semibold hover:file:bg-gray-200" />
            <p className="text-xs text-gray-400 mt-1.5">
              Required columns: first_name, last_name, email, mobile, designation, role.
              middle_name is optional. Leave temp_password blank to auto-generate a strong
              password per user — every generated password is shown here immediately after
              upload so you can share it with the new user; it is never shown again after this.
            </p>
          </div>

          {result && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3 text-sm">
                  <span className="font-semibold text-gray-700">{result.total} row{result.total === 1 ? "" : "s"} processed</span>
                  <span className="flex items-center gap-1 text-green-700"><CheckCircle2 size={14} /> {result.created} created</span>
                  {result.failed > 0 && <span className="flex items-center gap-1 text-red-600"><XCircle size={14} /> {result.failed} failed</span>}
                </div>
                {result.results.some((r) => r.status === "created" && r.temp_password) && (
                  <button type="button" onClick={() => copyAllCredentials(result.results)}
                    className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 rounded-lg text-xs font-semibold text-gray-700 hover:bg-gray-50">
                    <ClipboardCopy size={13} /> Copy All Credentials
                  </button>
                )}
              </div>
              <div className="border border-gray-200 rounded-xl overflow-hidden max-h-64 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 border-b sticky top-0">
                    <tr>{["Row", "Name", "Email", "Status", "Temporary Password"].map((h) => (
                      <th key={h} className="text-left px-3 py-2 font-semibold text-gray-600">{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {result.results.map((r) => (
                      <tr key={r.row}>
                        <td className="px-3 py-2 text-gray-500">{r.row}</td>
                        <td className="px-3 py-2 text-gray-700">{r.full_name || "—"}</td>
                        <td className="px-3 py-2 text-gray-700">{r.email ?? "—"}</td>
                        <td className="px-3 py-2">
                          {r.status === "created"
                            ? <span className="px-1.5 py-0.5 bg-green-100 text-green-700 rounded text-xs font-semibold">Created</span>
                            : <span className="px-1.5 py-0.5 bg-red-100 text-red-700 rounded text-xs font-semibold">Failed</span>}
                        </td>
                        <td className="px-3 py-2 text-gray-500">
                          {r.status === "created" && r.temp_password ? (
                            <span className="flex items-center gap-1.5">
                              <code className="font-mono text-[11px] bg-gray-100 px-1.5 py-0.5 rounded">{r.temp_password}</code>
                              <button type="button" onClick={() => copyToClipboard(r.temp_password!)} className="text-gray-400 hover:text-gray-600" title="Copy password"><Copy size={12} /></button>
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${r.password_generated ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600"}`}>
                                {r.password_generated ? "Auto-generated" : "From CSV"}
                              </span>
                            </span>
                          ) : (r.error ?? "—")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3 shrink-0">
          <button onClick={onClose} className="px-4 py-2.5 rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-100">Close</button>
          <button onClick={() => upload.mutate()} disabled={!file || upload.isPending}
            className="flex items-center gap-1.5 px-5 py-2.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-semibold hover:bg-[#178F8F] disabled:opacity-50">
            {upload.isPending ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} Upload
          </button>
        </div>
      </div>
    </div>
  );
}

// Collects a required reason (+ optional remarks) before deactivating a
// user — reactivation has no such requirement and stays a plain confirm
// (see the Power/PowerOff action below), matching how EditUserModal/
// CreateUserModal are each dedicated to one action rather than one modal
// branching on a mode flag.
function DeactivateUserModal({ user, onClose, onConfirm, isPending }: {
  user: AdminUser; onClose: () => void; onConfirm: (reasonType: string, remarks: string) => void; isPending: boolean;
}) {
  const [reasonType, setReasonType] = useState("retired");
  const [remarks, setRemarks] = useState("");
  const REMARKS_MAX = 1000;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-5 border-b border-gray-200">
          <h3 className="text-xl font-bold text-gray-900">Deactivate User</h3>
          <p className="text-sm text-gray-500 mt-1">{user.full_name} will no longer be able to sign in. Their historical records remain unchanged.</p>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className={LABEL}>Reason *</label>
            <select value={reasonType} onChange={(e) => setReasonType(e.target.value)} className={INPUT}>
              {DEACTIVATION_REASON_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div>
            <label className={LABEL}>Additional Remarks {reasonType === "other" ? "*" : "(optional)"}</label>
            <textarea
              value={remarks}
              onChange={(e) => setRemarks(e.target.value.slice(0, REMARKS_MAX))}
              maxLength={REMARKS_MAX}
              rows={3}
              className={`${INPUT} resize-none`}
              placeholder="Optional details…"
            />
            <p className="text-xs text-gray-400 mt-1 text-right">{remarks.length}/{REMARKS_MAX}</p>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2.5 rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-100">Cancel</button>
          <button
            onClick={() => onConfirm(reasonType, remarks)}
            disabled={isPending || (reasonType === "other" && !remarks.trim())}
            className="flex items-center gap-1 px-5 py-2.5 bg-red-600 text-white rounded-lg text-sm font-semibold hover:bg-red-700 disabled:opacity-50"
          >

            {isPending ? <Loader2 size={15} className="animate-spin" /> : null} Confirm Deactivation
          </button>
        </div>
      </div>
    </div>
  );
}

function ResetPasswordModal({ user, onClose, onConfirm, isPending }: {
  user: AdminUser;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h3 className="text-lg font-bold text-gray-900">Reset User Password</h3>
          <button onClick={onClose} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100" aria-label="Close"><X size={18} /></button>
        </div>
        <div className="space-y-3 px-6 py-5 text-sm text-gray-600">
          <p>Generate a new temporary password for <strong className="text-gray-900">{user.full_name}</strong>?</p>
          <p>The user will be signed out of existing sessions and must choose a new password immediately after logging in.</p>
        </div>
        <div className="flex justify-end gap-3 border-t px-6 py-4">
          <button onClick={onClose} className="rounded-lg px-4 py-2.5 text-sm font-semibold text-gray-600 hover:bg-gray-100">Cancel</button>
          <button onClick={onConfirm} disabled={isPending} className="flex items-center gap-2 rounded-lg bg-[#0D6E6E] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#178F8F] disabled:opacity-60">
            {isPending && <Loader2 size={15} className="animate-spin" />} Reset Password
          </button>
        </div>
      </div>
    </div>
  );
}

// One reassignable thing a leaver currently holds — a role, or a PI/
// project profile they're incharge of. See GET .../transfer-status.
interface TransferItem {
  kind: "role" | "project_profile";
  key: string;
  label: string;
  // kind="role" only: the exact role row and its "<establishment> ·
  // <department>" — one person can hold the same role in several places,
  // and each is reassigned separately.
  user_role_id?: string | null;
  context_label?: string | null;
  department_id: string | null;
  establishment_id: string | null;
  project_id: string | null;
  project_name: string | null;
}
interface TransferStatus { items: TransferItem[]; can_retire: boolean; }

// Per-item reassignment picker + action button. Its own target selection
// is local state — each item is reassigned independently by its own
// "Reassign" click, matching the confirmed flow (3 roles + 3 PI profiles
// can go to 6 different people, one at a time, partial progress allowed).
function TransferItemRow({ item, candidates, onReassign, isPending }: {
  item: TransferItem;
  candidates: { value: string; label: string }[];
  onReassign: (item: TransferItem, targetId: string) => void;
  isPending: boolean;
}) {
  const [targetId, setTargetId] = useState("");
  return (
    <div className="flex items-center gap-3 py-3 border-b border-gray-100 last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-800 truncate">{item.label}</p>
        {item.context_label && <p className="text-xs text-gray-600 truncate">{item.context_label}</p>}
        <p className="text-xs text-gray-400">{item.kind === "role" ? "Role" : "Project profile"}</p>
      </div>
      <div className="w-56 shrink-0">
        <SearchableSelect
          options={candidates}
          value={targetId}
          onChange={setTargetId}
          clearable={false}
          placeholder="Reassign to…"
          searchPlaceholder="Search by name or email…"
        />
      </div>
      <button
        onClick={() => onReassign(item, targetId)}
        disabled={!targetId || isPending}
        className="shrink-0 px-3 py-2 bg-[#0D6E6E] text-white rounded-lg text-xs font-semibold hover:bg-[#178F8F] disabled:opacity-50 flex items-center gap-1"
      >
        {isPending ? <Loader2 size={13} className="animate-spin" /> : null} Reassign
      </button>
    </div>
  );
}

// Replaces the old single-successor "transfer everything at once" flow.
// A leaver can hold several roles AND several PI/project profiles — each
// is reassigned to its OWN target user, independently, one action at a
// time (confirmed: up to 6 different destinations for 3 roles + 3 PI
// profiles is a normal case, not an edge case). The target user's own
// existing roles/profiles/files are never touched — reassignment only
// ADDS to them. Deactivating the leaver is blocked by the backend
// (PATCH .../status) until every item here is gone, so this modal has no
// "Retire" action of its own — once the list is empty, close this modal
// and use the normal Deactivate button.
function TransferOwnershipModal({ user, candidates, onClose }: {
  user: AdminUser;
  candidates: { value: string; label: string }[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: status, isLoading } = useQuery<TransferStatus>({
    queryKey: ["transfer-status", user.id],
    queryFn: async () => (await api.get(`/auth/admin/users/${user.id}/transfer-status`)).data,
  });

  const reassignRole = useMutation({
    mutationFn: ({ role, user_role_id, target_id }: { role: string; user_role_id?: string | null; target_id: string }) =>
      api.post(`/auth/admin/users/${user.id}/transfer-role`, { role, user_role_id, target_id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transfer-status", user.id] });
      qc.invalidateQueries({ queryKey: ["user-management-users"] });
      showSuccess("Role reassigned.");
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(typeof msg === "string" ? msg : "Could not reassign this role.");
    },
  });

  const reassignProfile = useMutation({
    mutationFn: ({ project_id, target_id }: { project_id: string; target_id: string }) =>
      api.post(`/projects/${project_id}/reassign`, { user_id: target_id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transfer-status", user.id] });
      qc.invalidateQueries({ queryKey: ["user-management-users"] });
      showSuccess("Project profile reassigned.");
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(typeof msg === "string" ? msg : "Could not reassign this project profile.");
    },
  });

  function handleReassign(item: TransferItem, targetId: string) {
    if (item.kind === "role") {
      reassignRole.mutate({ role: item.key, user_role_id: item.user_role_id, target_id: targetId });
    } else {
      if (!item.project_id) return;
      reassignProfile.mutate({ project_id: item.project_id, target_id: targetId });
    }
  }

  const isPending = reassignRole.isPending || reassignProfile.isPending;
  const items = status?.items ?? [];

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-5 border-b border-gray-200">
          <h3 className="text-xl font-bold text-gray-900">Transfer Ownership</h3>
          <p className="text-sm text-gray-500 mt-1">
            <span className="font-semibold text-gray-700">{user.full_name}</span> holds the role(s) and project
            profile(s) below. Reassign each one individually — they can go to different people, or the same
            person. Nothing about the target&apos;s own existing roles/profiles/files is touched; reassignment only
            adds. This is optional: deactivating {user.first_name || "this user"} does NOT require reassigning
            anything first — deactivation is a plain pause (nothing moves, everything comes back as-is on
            reactivation). Use this screen only when you actually want to hand specific roles/projects to
            someone else, e.g. before a permanent departure.
          </p>
        </div>
        <div className="px-6 py-4 overflow-y-auto flex-1">
          {isLoading ? (
            <div className="flex items-center gap-2 text-gray-400 py-6"><Loader2 size={16} className="animate-spin" /> Loading…</div>
          ) : items.length === 0 ? (
            <div className="flex items-center gap-2 text-green-700 bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm font-semibold">
              <CheckCircle2 size={16} /> Nothing left to reassign.
            </div>
          ) : (
            items.map((item) => (
              <TransferItemRow
                key={`${item.kind}:${item.user_role_id ?? item.key}`}
                item={item}
                candidates={candidates}
                onReassign={handleReassign}
                isPending={isPending}
              />
            ))
          )}
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2.5 rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-100">Close</button>
        </div>
      </div>
    </div>
  );
}

export function UserManagementSection() {
  const qc = useQueryClient();
  const activeRole = useActiveRole();
  // Bulk import and Delete are Super-Admin-only in the UI, matching the
  // backend's _super_admin_only gate — hiding them here is a UX nicety, not
  // the security boundary; the API rejects a plain Admin regardless.
  const isSuperAdmin = activeRole === "super_admin";
  const [showCreate, setShowCreate] = useState(false);
  const [showBulkUpload, setShowBulkUpload] = useState(false);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [deactivatingUser, setDeactivatingUser] = useState<AdminUser | null>(null);
  const [resettingUser, setResettingUser] = useState<AdminUser | null>(null);
  const [temporaryPassword, setTemporaryPassword] = useState<{ user: AdminUser; password: string } | null>(null);
  const [transferUser, setTransferUser] = useState<AdminUser | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [page, setPage] = useState(1);

  const { data: users = [], isLoading } = useQuery<AdminUser[]>({
    queryKey: ["user-management-users", statusFilter],
    queryFn: async () => (await api.get(`/auth/admin/users?status=${statusFilter}`)).data,
  });
  const t = useTableSearchSort(users, adminUserRowText, adminUserSortValue, { key: "name", dir: "asc" });
  const { data: establishments = [] } = useQuery<Establishment[]>({
    queryKey: ["admin-establishments-all"], queryFn: async () => (await api.get("/admin/establishments/all")).data,
  });
  const { data: departments = [] } = useQuery<Department[]>({
    queryKey: ["admin-departments-all"], queryFn: async () => (await api.get("/admin/departments/all")).data,
  });
  const { data: roles = [] } = useQuery<RoleSummary[]>({
    queryKey: ["admin-roles"], queryFn: async () => (await api.get("/auth/admin/roles")).data,
    enabled: isSuperAdmin,
  });
  const roleOptions = buildRoleOptions(roles);

  const toggleStatus = useMutation({
    mutationFn: ({ id, is_active, reason_type, remarks }: { id: string; is_active: boolean; reason_type?: string; remarks?: string }) =>
      api.patch(`/auth/admin/users/${id}/status`, { is_active, reason_type, remarks }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["user-management-users"] });
      showSuccess("User status updated.");
      setDeactivatingUser(null);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(typeof msg === "string" ? msg : "Could not update user status.");
    },
  });

  const resetPassword = useMutation({
    mutationFn: (id: string) => api.post<{ temp_password: string }>(`/auth/admin/users/${id}/reset-password`),
    onSuccess: (response, id) => {
      const user = users.find((item) => item.id === id);
      if (user) setTemporaryPassword({ user, password: response.data.temp_password });
      setResettingUser(null);
      showSuccess("Temporary password generated.");
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(typeof msg === "string" ? msg : "Could not reset password.");
    },
  });


  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-lg font-bold text-gray-800">Users ({t.view.length})</h2>
        <div className="flex items-center gap-2 flex-wrap">
          <TableSearchInput
            value={t.query}
            onChange={(v) => { t.setQuery(v); setPage(1); }}
            placeholder="Search name, email, dept, role…"
            className="w-full sm:w-64"
          />
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value as StatusFilter); setPage(1); }}
            className="border border-gray-300 rounded-lg px-3 py-2.5 text-sm font-semibold text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]"
            aria-label="Filter by status"
          >
            <option value="all">Status: All</option>
            <option value="active">Status: Active</option>
            <option value="inactive">Status: Inactive</option>
          </select>
          {isSuperAdmin && (
            <button onClick={() => setShowBulkUpload(true)}
              className="flex items-center gap-1.5 px-4 py-2.5 border border-gray-300 text-gray-700 rounded-lg text-sm font-semibold hover:bg-gray-50">
              <Upload size={15} /> Bulk Upload
            </button>
          )}
          <button onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-4 py-2.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-semibold hover:bg-[#178F8F]">
            <Plus size={15} /> Create User
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-gray-400 py-8"><Loader2 size={16} className="animate-spin" /> Loading…</div>
      ) : (() => {
        const { pageRows, total, totalPages, page: safePage, start } = paginate(t.view, page);
        return (
        <div className="bg-white rounded-xl border border-gray-200">
          <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead className="bg-gray-50 border-b">
              <tr>
                <SortTh label="Name" sortKey="name" state={t} />
                <SortTh label="Email" sortKey="email" state={t} />
                <SortTh label="Designation" sortKey="designation" state={t} />
                <SortTh label="Department" sortKey="department" state={t} />
                <SortTh label="Role" sortKey="role" state={t} />
                <SortTh label="Status" sortKey="status" state={t} />
                <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-500 whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageRows.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">{u.full_name}</td>
                  <td className="px-4 py-3 text-gray-600 text-xs">{u.email}</td>
                  <td className="px-4 py-3 text-gray-500">{u.designation ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-500">{u.department_name ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-500">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span>{u.active_role ? roleLabelFor(u.active_role) : "—"}</span>
                      {(u.roles?.length ?? 0) > 1 && (
                        <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-[10px] font-semibold shrink-0">
                          +{(u.roles?.length ?? 1) - 1} more role{(u.roles?.length ?? 1) - 1 !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {u.is_active
                      ? <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs font-semibold">Active</span>
                      : <span className="px-2 py-0.5 bg-gray-200 text-gray-600 rounded-full text-xs font-semibold">Inactive</span>}
                    {u.must_change_password && (
                      <span className="ml-1.5 px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full text-xs font-semibold">Temp Password</span>
                    )}
                    {!u.is_active && u.deactivation_reason_type && (
                      <p className="text-xs text-gray-400 mt-1">
                        {DEACTIVATION_REASON_OPTIONS.find((r) => r.value === u.deactivation_reason_type)?.label ?? u.deactivation_reason_type}
                        {u.deactivated_at ? ` — ${new Date(u.deactivated_at).toLocaleDateString()}` : ""}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      {isSuperAdmin && (
                        <button onClick={() => setEditingUser(u)} title="Edit" className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
                          <Pencil size={15} />
                        </button>
                      )}
                      {isSuperAdmin && u.is_active && (
                        <button
                          onClick={() => setTransferUser(u)}
                          title="Transfer ownership (reassign roles / project profiles)"
                          className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-[#0D6E6E]"
                        >
                          <ArrowRightLeft size={15} />
                        </button>
                      )}
                      {isSuperAdmin && (
                        <button
                          onClick={() => setResettingUser(u)}
                          title="Reset password"
                          className="p-2 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-[#0D6E6E]"
                        >
                          <KeyRound size={15} />
                        </button>
                      )}
                      {isSuperAdmin && (
                        <button
                          onClick={async () => {
                            if (!u.is_active) {
                              toggleStatus.mutate({ id: u.id, is_active: true });
                              return;
                            }
                            setDeactivatingUser(u);
                          }}
                          title={u.is_active ? "Deactivate" : "Activate"}
                          className={`p-2 rounded-lg hover:bg-gray-100 ${u.is_active ? "text-gray-400 hover:text-red-500" : "text-gray-400 hover:text-green-600"}`}
                        >
                          {u.is_active ? <PowerOff size={15} /> : <Power size={15} />}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <TablePagination page={safePage} totalPages={totalPages} total={total} start={start} pageCount={pageRows.length} onPage={setPage} />
        </div>
        );
      })()}

      {showCreate && (
        <CreateUserModal onClose={() => setShowCreate(false)} establishments={establishments} departments={departments} roleOptions={roleOptions} />
      )}
      {editingUser && (
        <EditUserModal user={editingUser} onClose={() => setEditingUser(null)} establishments={establishments} departments={departments} roleOptions={roleOptions} />
      )}
      {deactivatingUser && (
        <DeactivateUserModal
          user={deactivatingUser}
          onClose={() => setDeactivatingUser(null)}
          isPending={toggleStatus.isPending}
          onConfirm={(reason_type, remarks) =>
            toggleStatus.mutate({ id: deactivatingUser.id, is_active: false, reason_type, remarks })
          }
        />
      )}
      {resettingUser && (
        <ResetPasswordModal
          user={resettingUser}
          onClose={() => { if (!resetPassword.isPending) setResettingUser(null); }}
          isPending={resetPassword.isPending}
          onConfirm={() => resetPassword.mutate(resettingUser.id)}
        />
      )}
      {temporaryPassword && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b px-6 py-4">
              <h3 className="text-lg font-bold text-gray-900">Temporary Password</h3>
              <button onClick={() => setTemporaryPassword(null)} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100" aria-label="Close"><X size={18} /></button>
            </div>
            <div className="space-y-3 px-6 py-5 text-sm text-gray-600">
              <p>Share this password securely with <strong className="text-gray-900">{temporaryPassword.user.email}</strong>. It will not be shown again.</p>
              <div className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2.5 font-mono text-sm text-gray-900">
                <span>{temporaryPassword.password}</span>
                <button onClick={() => copyToClipboard(temporaryPassword.password)} className="rounded p-1 text-gray-500 hover:bg-gray-200" title="Copy temporary password"><ClipboardCopy size={15} /></button>
              </div>
              <p className="text-amber-700">The user must change this password immediately after logging in.</p>
            </div>
            <div className="flex justify-end border-t px-6 py-4">
              <button onClick={() => setTemporaryPassword(null)} className="rounded-lg bg-[#0D6E6E] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#178F8F]">Done</button>
            </div>
          </div>
        </div>
      )}
      {transferUser && (
        <TransferOwnershipModal
          user={transferUser}
          candidates={t.view
            .filter((u) => u.is_active && u.id !== transferUser.id)
            .map((u) => ({ value: u.id, label: u.employee_code ? `${u.full_name} (${u.employee_code})` : `${u.full_name} — ${u.email}` }))}
          onClose={() => setTransferUser(null)}
        />
      )}
      {isSuperAdmin && showBulkUpload && (
        <BulkUploadModal onClose={() => setShowBulkUpload(false)} />
      )}
    </div>
  );
}
