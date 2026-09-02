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
  Plus, Loader2, X, Copy, RefreshCw, Eye, EyeOff, Pencil,
  Power, PowerOff, ShieldAlert, Upload, Download, CheckCircle2, XCircle, ClipboardCopy,
} from "lucide-react";
import { SearchableSelect } from "@/components/shared/searchable-select";
import { paginate, TablePagination } from "@/components/shared/table-pagination";

interface Establishment { id: string; name: string; code: string | null; is_active: boolean; }
interface Department { id: string; name: string; code: string | null; establishment_id: string | null; is_active: boolean; }

interface AdminUser {
  id: string; email: string; first_name: string | null; middle_name: string | null; last_name: string | null; full_name: string;
  mobile: string | null; employee_code: string | null; date_of_birth: string | null; designation: string | null;
  establishment_id: string | null; establishment_name: string | null;
  department_id: string | null; department_name: string | null;
  active_role: string | null; is_active: boolean; must_change_password: boolean; can_sign: boolean;
  deactivation_reason_type: string | null; deactivation_remarks: string | null;
  deactivated_at: string | null; deactivated_by: string | null;
}

type StatusFilter = "all" | "active" | "inactive";

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
  const [error, setError] = useState("");

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

  const roleLabel = roleOptions.find((r) => r.value === form.role)?.label ?? form.role;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-5 border-b border-gray-200 flex items-center justify-between shrink-0">
          <h3 className="text-xl font-bold text-gray-900">Create User</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>

        <div className="overflow-y-auto px-6 py-5 flex-1">
          {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">{error}</div>}

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
  const [error, setError] = useState("");

  const save = useMutation({
    mutationFn: () => api.patch(`/auth/admin/users/${user.id}`, {
      first_name: form.first_name, middle_name: form.middle_name || "", last_name: form.last_name, email: form.email,
      mobile: form.mobile, employee_code: form.employee_code || null,
      date_of_birth: form.date_of_birth || null, designation: form.designation,
      establishment_id: form.establishment_id || null, department_id: form.department_id || null,
      role: form.role,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["user-management-users"] });
      showSuccess("User updated.");
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
          <UserFields form={form} setForm={setForm} establishments={establishments} departments={departments} roleOptions={roleOptions} />
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
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [page, setPage] = useState(1);

  const { data: users = [], isLoading } = useQuery<AdminUser[]>({
    queryKey: ["user-management-users", statusFilter],
    queryFn: async () => (await api.get(`/auth/admin/users?status=${statusFilter}`)).data,
  });
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-gray-800">Users ({users.length})</h2>
        <div className="flex items-center gap-2">
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
        const { pageRows, total, totalPages, page: safePage, start } = paginate(users, page);
        return (
        <div className="bg-white rounded-xl border border-gray-200">
          <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead className="bg-gray-50 border-b">
              <tr>{["Name", "Email", "Designation", "Department", "Role", "Status", "Actions"].map((h) => (
                <th key={h} className="text-left px-4 py-3 font-semibold text-gray-600 whitespace-nowrap">{h}</th>
              ))}</tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageRows.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">{u.full_name}</td>
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
      {isSuperAdmin && showBulkUpload && (
        <BulkUploadModal onClose={() => setShowBulkUpload(false)} />
      )}
    </div>
  );
}
