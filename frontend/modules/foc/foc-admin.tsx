"use client";
// FOC set-up for the Super Admin: projects (the project / bank / fund
// details printed on every FOC), FOC sheets with their budget lines, and the
// approving officers (several DDOs; one Assistant Comptroller, Finance
// Officer and Vice Chancellor).
import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Eye, Loader2, Pencil, Plus, Trash2, X, UserPlus } from "lucide-react";
import { api } from "@/services/api";
import { cn } from "@/lib/utils";
import { confirmAction, showSuccess } from "@/lib/alert";
import { SearchableSelect } from "@/components/shared/searchable-select";
import { makeDepartmentLabel } from "@/lib/department-label";
import {
  FOC_ROLE_TITLES, STATUS_BADGE, apiDetail, formatFocDate, formatINR, personLabel,
  type FocPerson, type FocProject, type FocRole, type FocSheet, type FocSummary,
} from "@/lib/foc";

interface Estb { id: string; name: string; is_active?: boolean }
interface Dept { id: string; name: string; establishment_id?: string | null; is_active?: boolean }
interface AdminUser { id: string; full_name: string; email: string; designation: string | null; is_active: boolean; is_retired?: boolean; department_name?: string | null; establishment_name?: string | null }
interface Officer { id: string; role: FocRole; role_title: string; user: FocPerson | null }

const INPUT = "w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]";
const LABEL = "block text-xs font-semibold text-gray-600 mb-1";
const BTN_PRIMARY = "flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold bg-[#0D6E6E] text-white hover:bg-[#178F8F] disabled:opacity-50";
const BTN_GHOST = "px-5 py-2.5 rounded-xl text-sm font-medium border border-gray-200 hover:bg-gray-50";

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <div className={cn("bg-white rounded-2xl shadow-xl w-full", wide ? "max-w-4xl" : "max-w-2xl")}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-bold text-gray-900">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

function usePeople() {
  return useQuery<AdminUser[]>({
    queryKey: ["foc-admin-users"],
    queryFn: () => api.get("/auth/admin/users", { params: { status: "active" } }).then((r) => r.data),
    select: (rows) => rows.filter((u) => u.is_active && !u.is_retired),
  });
}

function personOption(u: AdminUser) {
  const meta = [u.designation, u.department_name, u.establishment_name].filter(Boolean).join(" · ");
  return { value: u.id, label: meta ? `${u.full_name} — ${meta}` : u.full_name };
}

// ── Projects ────────────────────────────────────────────────────────────────

type ProjectForm = Omit<FocProject, "id" | "establishment_name" | "department_name">;
const EMPTY_PROJECT: ProjectForm = {
  name: "", funded_by: "", funding_agency: "", establishment_id: "", department_id: "", pi_name: "", project_type: "",
  bank_account_holder: "", bank_name: "", bank_account_no: "", fund_instrument_no: "", fund_received_date: "",
  fund_sanction_remittance_no: "", is_active: true,
};

function ProjectModal({ project, onClose }: { project: FocProject | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<ProjectForm>(() => project ? {
    ...EMPTY_PROJECT,
    ...Object.fromEntries(Object.entries(project).map(([k, v]) => [k, v ?? ""])),
    is_active: project.is_active,
  } as ProjectForm : EMPTY_PROJECT);
  const { data: estbs = [] } = useQuery<Estb[]>({ queryKey: ["admin-estb-all"], queryFn: () => api.get("/admin/establishments/all").then((r) => r.data) });
  const { data: depts = [] } = useQuery<Dept[]>({ queryKey: ["admin-dept-all"], queryFn: () => api.get("/admin/departments/all").then((r) => r.data) });
  const deptLabel = useMemo(() => makeDepartmentLabel(depts, estbs), [depts, estbs]);
  const deptOptions = depts.filter((d) => !form.establishment_id || d.establishment_id === form.establishment_id);

  const save = useMutation({
    mutationFn: async () => {
      const body = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v === "" ? null : v]));
      return project ? api.patch(`/foc/projects/${project.id}`, body) : api.post("/foc/projects", body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["foc-projects"] });
      showSuccess(project ? "Project updated." : "Project created.");
      onClose();
    },
    onError: (err) => toast.error(apiDetail(err, "Could not save the project.")),
  });

  const text = (k: keyof ProjectForm, label: string, opts: { type?: string; span?: boolean } = {}) => (
    <div className={opts.span ? "sm:col-span-2" : ""}>
      <label className={LABEL}>{label}</label>
      <input type={opts.type ?? "text"} value={String(form[k] ?? "")} onChange={(e) => setForm({ ...form, [k]: e.target.value })} className={INPUT} />
    </div>
  );

  return (
    <Modal title={project ? "Edit FOC project" : "New FOC project"} onClose={onClose}>
      <div className="space-y-5">
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-[#0A5757] mb-2">Project</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {text("name", "Name of the project *", { span: true })}
            {text("funded_by", "Funded by")}
            {text("funding_agency", "Funding agency")}
            <div>
              <label className={LABEL}>Establishment</label>
              <SearchableSelect options={estbs.map((e) => ({ value: e.id, label: e.name }))} value={form.establishment_id ?? ""}
                onChange={(v) => setForm({ ...form, establishment_id: v, department_id: "" })} placeholder="None" searchPlaceholder="Search establishments…" />
            </div>
            <div>
              <label className={LABEL}>Department / office</label>
              <SearchableSelect options={deptOptions.map((d) => ({ value: d.id, label: deptLabel(d) }))} value={form.department_id ?? ""}
                onChange={(v) => setForm({ ...form, department_id: v })} placeholder="None" searchPlaceholder="Search departments…" />
            </div>
            {text("pi_name", "Project P.I. name")}
            {text("project_type", "Type of project (e.g. 100%)")}
          </div>
        </div>
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-[#0A5757] mb-2">Bank account</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {text("bank_account_holder", "Account holder")}
            {text("bank_name", "Bank name")}
            {text("bank_account_no", "Account number")}
          </div>
        </div>
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-[#0A5757] mb-2">Fund information</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {text("fund_instrument_no", "Fund received instrument no.")}
            {text("fund_received_date", "Fund received date", { type: "date" })}
            {text("fund_sanction_remittance_no", "Fund sanction remittance no.", { span: true })}
          </div>
        </div>
        {project && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} className="accent-[#0D6E6E]" />
            Active (new FOCs can be created for it)
          </label>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className={BTN_GHOST}>Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !form.name.trim()} className={BTN_PRIMARY}>
            {save.isPending && <Loader2 size={15} className="animate-spin" />} Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ProjectsTab() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<FocProject | null | "new">(null);
  const { data = [], isLoading } = useQuery<FocProject[]>({ queryKey: ["foc-projects"], queryFn: () => api.get("/foc/projects").then((r) => r.data) });

  async function remove(p: FocProject) {
    if (!(await confirmAction({ title: "Delete this project?", text: `“${p.name}” will be deleted.`, confirmText: "Delete", danger: true }))) return;
    try {
      await api.delete(`/foc/projects/${p.id}`);
      qc.invalidateQueries({ queryKey: ["foc-projects"] });
      showSuccess("Project deleted.");
    } catch (err) { toast.error(apiDetail(err, "Could not delete the project.")); }
  }

  return (
    <div>
      <div className="flex justify-end mb-3">
        <button onClick={() => setEditing("new")} className={BTN_PRIMARY}><Plus size={15} /> New project</button>
      </div>
      <div className="bg-white rounded-2xl border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
            {["Project", "Funded by / Agency", "Establishment / Department", "P.I.", "Bank", "Status", ""].map((h) => <th key={h} className="px-4 py-3 font-semibold">{h}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {data.map((p) => (
              <tr key={p.id}>
                <td className="px-4 py-3 font-semibold text-gray-900">{p.name}</td>
                <td className="px-4 py-3 text-gray-700">{[p.funded_by, p.funding_agency].filter(Boolean).join(" / ") || "—"}</td>
                <td className="px-4 py-3 text-gray-700">{[p.establishment_name, p.department_name].filter(Boolean).join(" / ") || "—"}</td>
                <td className="px-4 py-3 text-gray-700">{p.pi_name || "—"}</td>
                <td className="px-4 py-3 text-gray-700">{[p.bank_name, p.bank_account_no].filter(Boolean).join(" · ") || "—"}</td>
                <td className="px-4 py-3">
                  <span className={cn("px-2 py-0.5 rounded-full text-xs font-semibold border", p.is_active ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-gray-100 text-gray-600 border-gray-200")}>
                    {p.is_active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-right">
                  <button onClick={() => setEditing(p)} className="text-[#0D6E6E] hover:underline text-xs font-semibold mr-3"><Pencil size={12} className="inline -mt-0.5" /> Edit</button>
                  <button onClick={() => remove(p)} className="text-red-600 hover:underline text-xs font-semibold"><Trash2 size={12} className="inline -mt-0.5" /> Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {isLoading && <p className="text-center text-gray-400 py-8"><Loader2 className="inline animate-spin" /></p>}
        {!isLoading && !data.length && <p className="text-center text-gray-400 py-10 text-sm">No FOC projects yet.</p>}
      </div>
      {editing && <ProjectModal project={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ── Sheets ──────────────────────────────────────────────────────────────────

interface LineForm { id?: string; sub_head: string; sanctioned_fund: string; available_fund: string }

function SheetModal({ sheetId, onClose }: { sheetId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: projects = [] } = useQuery<FocProject[]>({ queryKey: ["foc-projects"], queryFn: () => api.get("/foc/projects").then((r) => r.data) });
  const { data: fys } = useQuery<{ current: string; years: string[] }>({ queryKey: ["foc-fys"], queryFn: () => api.get("/foc/financial-years").then((r) => r.data) });
  const { data: people = [] } = usePeople();
  const { data: existing, isLoading } = useQuery<FocSheet>({
    queryKey: ["foc-sheet", sheetId], queryFn: () => api.get(`/foc/sheets/${sheetId}`).then((r) => r.data), enabled: !!sheetId,
  });

  const [form, setForm] = useState<{ project_id: string; financial_year: string; name: string; incharge_id: string; lines: LineForm[] } | null>(null);
  const current = form ?? (sheetId
    ? existing && {
      project_id: existing.project.id, financial_year: existing.financial_year, name: existing.name, incharge_id: existing.incharge?.id ?? "",
      lines: existing.lines.map((l) => ({ id: l.id, sub_head: l.sub_head, sanctioned_fund: l.sanctioned_fund, available_fund: l.available_fund })),
    }
    : { project_id: "", financial_year: fys?.current ?? "", name: "", incharge_id: "", lines: [{ sub_head: "", sanctioned_fund: "", available_fund: "" }] });
  const update = (patch: Partial<NonNullable<typeof current>>) => current && setForm({ ...current, ...patch });
  const setLine = (i: number, patch: Partial<LineForm>) => current && update({ lines: current.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });

  const save = useMutation({
    mutationFn: async () => {
      if (!current) return;
      const body = { ...current, lines: current.lines.map((l) => ({ ...l, sanctioned_fund: l.sanctioned_fund || "0", available_fund: l.available_fund || "0" })) };
      if (sheetId) {
        const { project_id: _p, ...rest } = body;
        void _p;
        return api.patch(`/foc/sheets/${sheetId}`, rest);
      }
      return api.post("/foc/sheets", body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["foc-sheets"] });
      qc.invalidateQueries({ queryKey: ["foc-sheet", sheetId] });
      showSuccess(sheetId ? "FOC updated." : "FOC created. The in-charge has been notified.");
      onClose();
    },
    onError: (err) => toast.error(apiDetail(err, "Could not save the FOC.")),
  });

  const locked = !!existing && !["draft", "rejected"].includes(existing.status);
  const total = (k: "sanctioned_fund" | "available_fund") => current?.lines.reduce((s, l) => s + (parseFloat(l[k]) || 0), 0) ?? 0;

  return (
    <Modal title={sheetId ? `Edit FOC #${existing?.number ?? ""}` : "New FOC"} onClose={onClose} wide>
      {!current || (sheetId && isLoading) ? <p className="text-center text-gray-400 py-8"><Loader2 className="inline animate-spin" /></p> : (
        <div className="space-y-5">
          {locked && <p className="text-sm bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-4 py-2">This FOC is {existing?.status_label.toLowerCase()} and can no longer be changed.</p>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label className={LABEL}>Project *</label>
              <SearchableSelect options={projects.filter((p) => p.is_active || p.id === current.project_id).map((p) => ({ value: p.id, label: p.name }))}
                value={current.project_id} onChange={(v) => update({ project_id: v })} disabled={!!sheetId}
                placeholder="Choose a project…" searchPlaceholder="Search projects…" clearable={false} />
            </div>
            <div>
              <label className={LABEL}>Financial year *</label>
              <select value={current.financial_year} onChange={(e) => update({ financial_year: e.target.value })} className={INPUT} disabled={locked}>
                {(fys?.years ?? []).map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
            <div>
              <label className={LABEL}>FOC name * <span className="font-normal text-gray-400">(e.g. October 2025)</span></label>
              <input value={current.name} onChange={(e) => update({ name: e.target.value })} className={INPUT} maxLength={200} disabled={locked} />
            </div>
            <div className="sm:col-span-2">
              <label className={LABEL}>FOC in-charge *</label>
              <SearchableSelect options={people.map(personOption)} value={current.incharge_id} onChange={(v) => update({ incharge_id: v })}
                placeholder="Choose the in-charge…" searchPlaceholder="Search people…" clearable={false} widePanel disabled={locked} />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-bold uppercase tracking-wide text-[#0A5757]">Budget lines</p>
              {!locked && (
                <button onClick={() => update({ lines: [...current.lines, { sub_head: "", sanctioned_fund: "", available_fund: "" }] })}
                  className="text-xs font-semibold text-[#0D6E6E] hover:underline flex items-center gap-1"><Plus size={13} /> Add line</button>
              )}
            </div>
            <div className="border border-gray-200 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead><tr className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                  <th className="px-3 py-2 w-12">Sl</th><th className="px-3 py-2">Sub head</th>
                  <th className="px-3 py-2 w-44">Sanctioned fund (₹)</th><th className="px-3 py-2 w-44">Available fund (₹)</th><th className="w-10" />
                </tr></thead>
                <tbody className="divide-y divide-gray-100">
                  {current.lines.map((l, i) => {
                    const over = (parseFloat(l.available_fund) || 0) > (parseFloat(l.sanctioned_fund) || 0);
                    return (
                      <tr key={l.id ?? `new-${i}`}>
                        <td className="px-3 py-2 text-gray-500">{i + 1}</td>
                        <td className="px-3 py-2"><input value={l.sub_head} onChange={(e) => setLine(i, { sub_head: e.target.value })} className={INPUT} maxLength={300} disabled={locked} /></td>
                        <td className="px-3 py-2"><input type="number" min={0} step="0.01" value={l.sanctioned_fund} onChange={(e) => setLine(i, { sanctioned_fund: e.target.value })} className={cn(INPUT, "text-right font-mono")} disabled={locked} /></td>
                        <td className="px-3 py-2">
                          <input type="number" min={0} step="0.01" value={l.available_fund} onChange={(e) => setLine(i, { available_fund: e.target.value })}
                            className={cn(INPUT, "text-right font-mono", over && "border-red-500")} disabled={locked} />
                          {over && <p className="text-[11px] text-red-600 mt-0.5">More than sanctioned</p>}
                        </td>
                        <td className="px-2">
                          {!locked && current.lines.length > 1 && (
                            <button onClick={() => update({ lines: current.lines.filter((_, j) => j !== i) })} className="text-red-400 hover:text-red-600"><Trash2 size={14} /></button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="bg-gray-50 font-semibold">
                    <td /><td className="px-3 py-2 text-right text-gray-600">Total</td>
                    <td className="px-3 py-2 text-right font-mono">{formatINR(total("sanctioned_fund"))}</td>
                    <td className="px-3 py-2 text-right font-mono">{formatINR(total("available_fund"))}</td><td />
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className={BTN_GHOST}>Cancel</button>
            {!locked && (
              <button onClick={() => save.mutate()}
                disabled={save.isPending || !current.project_id || !current.name.trim() || !current.incharge_id || !current.lines.length}
                className={BTN_PRIMARY}>
                {save.isPending && <Loader2 size={15} className="animate-spin" />} {sheetId ? "Save changes" : "Create FOC"}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function SheetsTab() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [status, setStatus] = useState("");
  const { data = [], isLoading } = useQuery<FocSummary[]>({
    queryKey: ["foc-sheets", status],
    queryFn: () => api.get("/foc/sheets", { params: status ? { status } : {} }).then((r) => r.data),
  });

  async function remove(s: FocSummary) {
    if (!(await confirmAction({ title: "Delete this FOC?", text: `FOC #${s.number} “${s.name}” will be deleted.`, confirmText: "Delete", danger: true }))) return;
    try {
      await api.delete(`/foc/sheets/${s.id}`);
      qc.invalidateQueries({ queryKey: ["foc-sheets"] });
      showSuccess("FOC deleted.");
    } catch (err) { toast.error(apiDetail(err, "Could not delete the FOC.")); }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="border border-gray-300 rounded-xl px-3 py-2 text-sm bg-white">
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="pending">With officers</option>
          <option value="rejected">Returned</option>
          <option value="approved">Approved</option>
        </select>
        <button onClick={() => setEditing("new")} className={BTN_PRIMARY}><Plus size={15} /> New FOC</button>
      </div>
      <div className="bg-white rounded-2xl border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
            {["ID", "FOC", "Project", "FY", "In-charge", "Amount required (₹)", "Status", "Updated", ""].map((h) => <th key={h} className="px-4 py-3 font-semibold whitespace-nowrap">{h}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {data.map((s) => {
              const editable = s.status === "draft" || s.status === "rejected";
              return (
                <tr key={s.id}>
                  <td className="px-4 py-3 font-mono font-semibold text-[#0A5757]">{s.number}</td>
                  <td className="px-4 py-3 font-semibold text-gray-900">{s.name}</td>
                  <td className="px-4 py-3 text-gray-700">{s.project_name}</td>
                  <td className="px-4 py-3 text-gray-700">{s.financial_year}</td>
                  <td className="px-4 py-3 text-gray-700">{personLabel(s.incharge)}</td>
                  <td className="px-4 py-3 text-right font-mono">{formatINR(s.total_required)}</td>
                  <td className="px-4 py-3"><span className={cn("px-2 py-0.5 rounded-full text-xs font-semibold border whitespace-nowrap", STATUS_BADGE[s.status])}>{s.status_label}</span></td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{formatFocDate(s.updated_at)}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-right">
                    <Link href={`/foc/sheets/${s.id}`} className="text-gray-600 hover:underline text-xs font-semibold mr-3"><Eye size={12} className="inline -mt-0.5" /> View</Link>
                    {editable && <button onClick={() => setEditing(s.id)} className="text-[#0D6E6E] hover:underline text-xs font-semibold mr-3"><Pencil size={12} className="inline -mt-0.5" /> Edit</button>}
                    {s.status === "draft" && !s.submitted_at && <button onClick={() => remove(s)} className="text-red-600 hover:underline text-xs font-semibold"><Trash2 size={12} className="inline -mt-0.5" /> Delete</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {isLoading && <p className="text-center text-gray-400 py-8"><Loader2 className="inline animate-spin" /></p>}
        {!isLoading && !data.length && <p className="text-center text-gray-400 py-10 text-sm">No FOCs yet.</p>}
      </div>
      {editing && <SheetModal sheetId={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ── Officers ────────────────────────────────────────────────────────────────

function OfficersTab() {
  const qc = useQueryClient();
  const { data: officers = [], isLoading } = useQuery<Officer[]>({ queryKey: ["foc-officers"], queryFn: () => api.get("/foc/officers").then((r) => r.data) });
  const { data: people = [] } = usePeople();
  const [picks, setPicks] = useState<Record<string, string>>({});

  const assign = useMutation({
    mutationFn: ({ role, user_id }: { role: FocRole; user_id: string }) => api.post("/foc/officers", { role, user_id }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["foc-officers"] });
      setPicks((p) => ({ ...p, [v.role]: "" }));
      showSuccess(`${FOC_ROLE_TITLES[v.role]} assigned.`);
    },
    onError: (err) => toast.error(apiDetail(err, "Could not assign the officer.")),
  });

  async function remove(o: Officer) {
    if (!(await confirmAction({ title: `Remove ${o.user?.full_name}?`, text: `They will no longer act as ${o.role_title} in FOC.`, confirmText: "Remove", danger: true }))) return;
    try {
      await api.delete(`/foc/officers/${o.id}`);
      qc.invalidateQueries({ queryKey: ["foc-officers"] });
    } catch (err) { toast.error(apiDetail(err, "Could not remove the officer.")); }
  }

  const ddos = officers.filter((o) => o.role === "ddo");
  const fixed: FocRole[] = ["assistant_comptroller", "finance_officer", "vice_chancellor"];
  const picker = (role: FocRole, label: string, exclude: string[] = []) => (
    <div className="flex gap-2 items-end">
      <div className="flex-1">
        <SearchableSelect options={people.filter((u) => !exclude.includes(u.id)).map(personOption)} value={picks[role] ?? ""}
          onChange={(v) => setPicks((p) => ({ ...p, [role]: v }))} placeholder={label} searchPlaceholder="Search people…" widePanel />
      </div>
      <button onClick={() => picks[role] && assign.mutate({ role, user_id: picks[role] })} disabled={!picks[role] || assign.isPending} className={BTN_PRIMARY}>
        <UserPlus size={15} /> Assign
      </button>
    </div>
  );

  if (isLoading) return <p className="text-center text-gray-400 py-8"><Loader2 className="inline animate-spin" /></p>;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div className="bg-white rounded-2xl border border-gray-200 p-5 lg:row-span-3">
        <h3 className="text-base font-bold text-gray-900">DDOs</h3>
        <p className="text-xs text-gray-500 mb-3">There can be several. The in-charge chooses one of them when sending an FOC.</p>
        <div className="space-y-2 mb-4">
          {ddos.map((o) => (
            <div key={o.id} className="flex items-center justify-between p-3 rounded-xl bg-gray-50 border border-gray-100">
              <div><p className="text-sm font-semibold text-gray-900">{o.user?.full_name}</p><p className="text-xs text-gray-500">{o.user?.designation ?? o.user?.email}</p></div>
              <button onClick={() => remove(o)} className="text-red-500 hover:text-red-700 text-xs font-semibold flex items-center gap-1"><Trash2 size={12} /> Remove</button>
            </div>
          ))}
          {!ddos.length && <p className="text-sm text-gray-400">No DDO yet.</p>}
        </div>
        {picker("ddo", "Add a DDO…", ddos.map((o) => o.user?.id ?? ""))}
      </div>
      {fixed.map((role) => {
        const o = officers.find((x) => x.role === role);
        return (
          <div key={role} className="bg-white rounded-2xl border border-gray-200 p-5">
            <h3 className="text-base font-bold text-gray-900">{FOC_ROLE_TITLES[role]}</h3>
            <p className="text-xs text-gray-500 mb-3">One person. FOCs are forwarded to them automatically.</p>
            {o ? (
              <div className="flex items-center justify-between p-3 rounded-xl bg-[#F4FAF9] border border-[#BFDEDB] mb-3">
                <div><p className="text-sm font-semibold text-gray-900">{o.user?.full_name}</p><p className="text-xs text-gray-500">{o.user?.designation ?? o.user?.email}</p></div>
                <button onClick={() => remove(o)} className="text-red-500 hover:text-red-700 text-xs font-semibold flex items-center gap-1"><Trash2 size={12} /> Remove</button>
              </div>
            ) : <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mb-3">Not assigned — FOCs cannot be forwarded to this stage yet.</p>}
            {picker(role, o ? "Replace with…" : "Choose…", o?.user ? [o.user.id] : [])}
          </div>
        );
      })}
    </div>
  );
}

export function FocAdminPage() {
  const [tab, setTab] = useState<"sheets" | "projects" | "officers">("sheets");
  const tabs = [["sheets", "FOC Sheets"], ["projects", "Projects"], ["officers", "Officers"]] as const;
  return (
    <div>
      <h1 className="text-2xl font-bold text-[#1A1A2E]">FOC Setup</h1>
      <p className="text-sm text-gray-500 mt-0.5 mb-4">Create projects and FOCs, and choose who approves them.</p>
      <div className="flex gap-1 border-b border-gray-200 mb-5">
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={cn("px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px", tab === k ? "border-[#0D6E6E] text-[#0D6E6E]" : "border-transparent text-gray-500 hover:text-gray-700")}>
            {label}
          </button>
        ))}
      </div>
      {tab === "sheets" && <SheetsTab />}
      {tab === "projects" && <ProjectsTab />}
      {tab === "officers" && <OfficersTab />}
    </div>
  );
}
