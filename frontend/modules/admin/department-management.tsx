"use client";
// Admin → Departments. Every department has its OWN code, even when two
// establishments have a department of the same name — so departments are
// added in bulk from an Excel sheet (Establishment Name, Establishment Code,
// Department Name, Department Code), or one at a time with the small form.
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Download, Eye, EyeOff, FileSpreadsheet, Loader2, Plus, Trash2, Upload, XCircle, MinusCircle } from "lucide-react";
import { api } from "@/services/api";
import { cn } from "@/lib/utils";
import { apiErrorDetail, confirmAction, showBlocked, showSuccess } from "@/lib/alert";
import { SearchableSelect } from "@/components/shared/searchable-select";

interface Establishment { id: string; name: string; code: string | null; is_active: boolean }
interface Department { id: string; name: string; code: string | null; establishment_id: string | null; is_active: boolean }
interface RowResult { row: number; establishment: string | null; department: string | null; status: "created" | "skipped" | "failed"; note: string | null }
interface BulkResult { total: number; created: number; skipped: number; failed: number; establishments_created: number; results: RowResult[] }

const INPUT = "w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]";
const LABEL = "block text-sm font-semibold text-gray-600 mb-1";

export function DepartmentManagementSection() {
  const qc = useQueryClient();
  const { data: establishments = [] } = useQuery<Establishment[]>({
    queryKey: ["admin-establishments-all"], queryFn: async () => (await api.get("/admin/establishments/all")).data,
  });
  const { data: departments = [] } = useQuery<Department[]>({
    queryKey: ["admin-departments-all"], queryFn: async () => (await api.get("/admin/departments/all")).data,
  });
  const refresh = () => ["admin-departments-all", "admin-establishments-all", "departments", "establishments"]
    .forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

  // ── Bulk upload ──
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [showAll, setShowAll] = useState(false);

  async function downloadTemplate() {
    setDownloading(true);
    try {
      const res = await api.get("/admin/departments/bulk/template", { responseType: "blob" });
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "department_upload_template.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Could not download the template.");
    } finally {
      setDownloading(false);
    }
  }

  async function upload() {
    if (!file) return;
    setUploading(true);
    setResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await api.post("/admin/departments/bulk", form, { headers: { "Content-Type": "multipart/form-data" } });
      const data = res.data as BulkResult;
      setResult(data);
      setShowAll(false);
      refresh();
      if (data.failed === 0) showSuccess(`${data.created} department${data.created === 1 ? "" : "s"} added${data.skipped ? `, ${data.skipped} already there` : ""}.`);
      else toast.warning(`${data.created} added, ${data.skipped} already there, ${data.failed} need fixing — see the list below.`);
      setFile(null);
      setFileKey((k) => k + 1);
    } catch (err) {
      toast.error(apiErrorDetail(err) ?? "Could not process the file.");
    } finally {
      setUploading(false);
    }
  }

  // ── Add one ──
  const [one, setOne] = useState({ establishment_id: "", name: "", code: "" });
  const [saving, setSaving] = useState(false);
  async function addOne() {
    setSaving(true);
    try {
      await api.post("/admin/departments", one);
      setOne((s) => ({ ...s, name: "", code: "" }));
      refresh();
      showSuccess("Department added.");
    } catch (err) {
      toast.error(apiErrorDetail(err) ?? "Could not add the department.");
    } finally {
      setSaving(false);
    }
  }

  // ── List ──
  const [filterEstb, setFilterEstb] = useState("");
  const [search, setSearch] = useState("");
  const estbName = useMemo(() => new Map(establishments.map((e) => [e.id, e.name])), [establishments]);
  const shown = departments
    .filter((d) => !filterEstb || d.establishment_id === filterEstb)
    .filter((d) => {
      const q = search.trim().toLowerCase();
      return !q || d.name.toLowerCase().includes(q) || (d.code ?? "").toLowerCase().includes(q) || (estbName.get(d.establishment_id ?? "") ?? "").toLowerCase().includes(q);
    });

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      refresh();
    } catch (err) {
      const msg = apiErrorDetail(err);
      if (msg && msg.includes("\n")) await showBlocked(msg);
      else toast.error(msg ?? "Action failed");
    }
  }
  async function remove(d: Department) {
    if (!(await confirmAction({ title: "Delete this department?", text: `"${d.name}" will be permanently deleted. This cannot be undone.`, confirmText: "Delete", danger: true }))) return;
    await act(() => api.delete(`/admin/departments/${d.id}`));
  }

  const problems = result?.results.filter((r) => r.status === "failed") ?? [];
  const rowsToShow = result ? (showAll ? result.results : problems) : [];

  return (
    <div className="space-y-6">
      {/* Bulk upload */}
      <div className="bg-gray-50 rounded-xl border border-gray-200 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
          <div>
            <p className="text-sm font-semibold text-gray-700 flex items-center gap-2"><FileSpreadsheet size={16} className="text-[#0D6E6E]" /> Add departments from Excel</p>
            <p className="text-xs text-gray-500 mt-0.5 max-w-2xl">
              One row per department with its establishment: <b>Establishment Name, Establishment Code, Department Name, Department Code</b>.
              A new establishment is created automatically. Every department needs its own code, even when two establishments have a department of the same name.
              A department the establishment already has is skipped.
            </p>
          </div>
          <button type="button" onClick={downloadTemplate} disabled={downloading}
            className="flex items-center gap-1.5 px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-100 disabled:opacity-50">
            {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Download template
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input key={fileKey} type="file" accept=".xlsx,.csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); }}
            className="block flex-1 min-w-[240px] text-sm text-gray-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-gray-200 file:text-gray-700 file:font-semibold hover:file:bg-gray-300" />
          <button type="button" onClick={upload} disabled={!file || uploading}
            className="flex items-center gap-1.5 px-4 py-2.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-semibold hover:bg-[#178F8F] disabled:opacity-50">
            {uploading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} Upload
          </button>
        </div>

        {result && (
          <div className="mt-4">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
              <span className="font-semibold text-gray-700">{result.total} row{result.total === 1 ? "" : "s"} read</span>
              <span className="text-emerald-700 font-semibold">{result.created} added</span>
              {result.establishments_created > 0 && <span className="text-emerald-700">{result.establishments_created} new establishment{result.establishments_created === 1 ? "" : "s"}</span>}
              <span className="text-gray-500">{result.skipped} already there</span>
              <span className={result.failed ? "text-red-700 font-semibold" : "text-gray-500"}>{result.failed} need fixing</span>
              <button type="button" onClick={() => setShowAll((v) => !v)} className="ml-auto text-xs font-semibold text-[#0D6E6E] hover:underline">
                {showAll ? "Show only rows that need fixing" : "Show every row"}
              </button>
            </div>
            {rowsToShow.length > 0 ? (
              <div className="mt-2 max-h-72 overflow-y-auto border border-gray-200 rounded-lg bg-white divide-y divide-gray-100">
                {rowsToShow.map((r) => (
                  <div key={r.row} className="flex items-start gap-3 px-3 py-2 text-sm">
                    {r.status === "created" ? <CheckCircle2 size={16} className="text-emerald-600 shrink-0 mt-0.5" />
                      : r.status === "skipped" ? <MinusCircle size={16} className="text-gray-400 shrink-0 mt-0.5" />
                      : <XCircle size={16} className="text-red-500 shrink-0 mt-0.5" />}
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900">Row {r.row}: {[r.establishment, r.department].filter(Boolean).join(" → ") || "(empty)"}</p>
                      {r.note && <p className={cn("text-xs", r.status === "failed" ? "text-red-600" : "text-gray-500")}>{r.note}</p>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-emerald-700 mt-2">Every row was read without problems.</p>
            )}
            {problems.length > 0 && <p className="text-xs text-gray-500 mt-2">Fix the rows above in your sheet and upload it again — rows already added are skipped, so nothing is doubled.</p>}
          </div>
        )}
      </div>

      {/* Add one */}
      <div className="bg-gray-50 rounded-xl border border-gray-200 p-4">
        <p className="text-sm font-semibold text-gray-700 mb-3">Add a single department</p>
        <div className="grid grid-cols-1 md:grid-cols-[1.2fr_1.2fr_0.6fr_auto] gap-3 items-end">
          <div>
            <label className={LABEL}>Establishment *</label>
            <SearchableSelect
              options={establishments.filter((e) => e.is_active).map((e) => ({ value: e.id, label: e.name }))}
              value={one.establishment_id} onChange={(v) => setOne((s) => ({ ...s, establishment_id: v }))}
              clearable={false} placeholder="Select…" searchPlaceholder="Search establishments…" />
          </div>
          <div>
            <label className={LABEL}>Department name *</label>
            <input value={one.name} onChange={(e) => setOne((s) => ({ ...s, name: e.target.value }))} placeholder="e.g. Agronomy" className={INPUT} />
          </div>
          <div>
            <label className={LABEL}>Code * (its own)</label>
            <input value={one.code} onChange={(e) => setOne((s) => ({ ...s, code: e.target.value.toUpperCase().slice(0, 20) }))} placeholder="e.g. AGRO" className={INPUT} />
          </div>
          <button type="button" onClick={addOne} disabled={saving || !one.establishment_id || !one.name.trim() || !one.code.trim()}
            className="flex items-center justify-center gap-1 px-4 py-2.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-semibold hover:bg-[#178F8F] disabled:opacity-50 whitespace-nowrap">
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Add
          </button>
        </div>
      </div>

      {/* List */}
      <div>
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <p className="text-sm font-semibold text-gray-700 mr-auto">Departments ({shown.length}{shown.length !== departments.length ? ` of ${departments.length}` : ""})</p>
          <div className="w-64">
            <SearchableSelect options={establishments.map((e) => ({ value: e.id, label: e.name }))} value={filterEstb} onChange={setFilterEstb}
              placeholder="All establishments" searchPlaceholder="Search establishments…" />
          </div>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or code…"
            className="w-56 border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]" />
        </div>
        {shown.length === 0 && <p className="text-sm text-gray-400 py-8 text-center">No departments{search || filterEstb ? " match" : " yet"}.</p>}
        {shown.map((d) => (
          <div key={d.id} className={cn("flex items-center justify-between px-4 py-3 rounded-lg border mb-2", d.is_active ? "bg-white border-gray-200" : "bg-gray-50 border-gray-100 opacity-60")}>
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold text-gray-900 truncate">{d.name}</p>
              <p className="text-sm text-gray-500 truncate">{[estbName.get(d.establishment_id ?? ""), d.code ? `Code: ${d.code}` : ""].filter(Boolean).join(" · ")}</p>
              {!d.is_active && <span className="text-xs text-amber-600 font-medium">Hidden</span>}
            </div>
            <div className="flex gap-1 ml-3 shrink-0">
              <button onClick={() => act(() => api.patch(`/admin/departments/${d.id}/toggle`, {}))} title={d.is_active ? "Hide" : "Show"}
                className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">{d.is_active ? <Eye size={16} /> : <EyeOff size={16} />}</button>
              <button onClick={() => remove(d)} title="Delete" className="p-2 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500"><Trash2 size={16} /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
