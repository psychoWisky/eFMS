"use client";
// Admin → Departments.
//   • "All departments": every department, one card per name, with the
//     establishments that have it and each one's code — edit, hide, remove.
//   • "Create new department": a guided section used ONLY for adding
//     departments, in three plain steps (how → which establishment → details):
//       – type a new one (name + code),
//       – copy ones other establishments already have (several at once, each
//         keeps its code unless you type a different one),
//       – upload an Excel sheet (Establishment Name, Establishment Code,
//         Department Name, Department Code).
// A department can only be in an establishment once. The same department may
// carry the same code in several establishments, but a code belongs to one
// department name. The same creation section opens from Establishments.
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CheckCircle2, Download, Eye, EyeOff, FileSpreadsheet, ListChecks, Loader2, Plus, Trash2, Upload, XCircle,
  MinusCircle, Lock, Pencil, X, Keyboard, ArrowLeft,
} from "lucide-react";
import { api } from "@/services/api";
import { cn } from "@/lib/utils";
import { apiErrorDetail, confirmAction, showBlocked, showSuccess } from "@/lib/alert";
import { SearchableSelect } from "@/components/shared/searchable-select";

interface Establishment { id: string; name: string; code: string | null; is_active: boolean }
interface Department { id: string; name: string; code: string | null; establishment_id: string | null; is_active: boolean }
interface RowResult { row: number; establishment: string | null; department: string | null; status: "created" | "skipped" | "failed"; note: string | null }
interface DeptName { name: string; code: string | null; codes: string[]; establishment_ids: string[]; count: number }
interface PickResult { establishment: string; created: number; skipped: number; failed: number; results: { name: string; status: "created" | "skipped" | "failed"; code: string | null; note: string | null }[] }
interface BulkResult { total: number; created: number; skipped: number; failed: number; establishments_created: number; results: RowResult[] }

const STEP = "w-7 h-7 rounded-full bg-[#0D6E6E] text-white text-sm font-bold flex items-center justify-center shrink-0";
const INPUT = "w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]";
const LABEL = "block text-sm font-semibold text-gray-600 mb-1";
const BTN = "flex items-center justify-center gap-1.5 px-4 py-2.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-semibold hover:bg-[#178F8F] disabled:opacity-50 whitespace-nowrap";

function useOrgData() {
  const qc = useQueryClient();
  const { data: establishments = [] } = useQuery<Establishment[]>({
    queryKey: ["admin-establishments-all"], queryFn: async () => (await api.get("/admin/establishments/all")).data,
  });
  const { data: departments = [] } = useQuery<Department[]>({
    queryKey: ["admin-departments-all"], queryFn: async () => (await api.get("/admin/departments/all")).data,
  });
  const { data: deptNames = [] } = useQuery<DeptName[]>({
    queryKey: ["admin-department-names"], queryFn: async () => (await api.get("/admin/departments/names")).data,
  });
  const refresh = () => ["admin-departments-all", "admin-department-names", "admin-establishments-all", "departments", "establishments"]
    .forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  return { establishments, departments, deptNames, refresh };
}

// ── Edit a name + code (departments, establishments) ────────────────────────

export function EditNameCodeModal({ title, hint, name, code, onSave, onClose }: {
  title: string; hint?: string; name: string; code: string | null;
  onSave: (name: string, code: string) => Promise<void>; onClose: () => void;
}) {
  const [n, setN] = useState(name);
  const [c, setC] = useState(code ?? "");
  const [saving, setSaving] = useState(false);
  const changed = n.trim() !== name.trim() || c.trim() !== (code ?? "").trim();
  async function save() {
    setSaving(true);
    try {
      await onSave(n.trim(), c.trim());
      onClose();
    } catch (err) {
      toast.error(apiErrorDetail(err) ?? "Could not save.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {hint && <p className="text-xs text-gray-500">{hint}</p>}
          <div>
            <label className={LABEL}>Name *</label>
            <input value={n} onChange={(e) => setN(e.target.value)} maxLength={255} className={INPUT} autoFocus />
          </div>
          <div>
            <label className={LABEL}>Code *</label>
            <input value={c} onChange={(e) => setC(e.target.value.toUpperCase())} maxLength={50} className={cn(INPUT, "font-mono")} />
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2.5 rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-100">Cancel</button>
          <button onClick={save} disabled={saving || !changed || !n.trim() || !c.trim()} className={BTN}>
            {saving && <Loader2 size={15} className="animate-spin" />} Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Create new department (guided) ───────────────────────────────────────────

type Method = "new" | "copy" | "excel";

export function CreateDepartmentPanel({ initialEstablishmentId = "" }: { initialEstablishmentId?: string }) {
  const { establishments, departments, deptNames, refresh } = useOrgData();
  const [method, setMethod] = useState<Method | null>(null);
  const [estbId, setEstbId] = useState(initialEstablishmentId);
  const estbLabel = establishments.find((e) => e.id === estbId)?.name ?? "";
  const inEstb = useMemo(() => departments.filter((d) => d.establishment_id === estbId), [departments, estbId]);
  const hasName = (n: string) => inEstb.some((d) => d.name.trim().toLowerCase() === n.trim().toLowerCase());
  const estbNameById = useMemo(() => new Map(establishments.map((e) => [e.id, e.name])), [establishments]);

  // Type a new one
  const [one, setOne] = useState({ name: "", code: "" });
  const [saving, setSaving] = useState(false);
  const oneTaken = !!one.name.trim() && !!estbId && hasName(one.name);
  const existsElsewhere = !oneTaken && !!one.name.trim() && deptNames.some((n) => n.name.toLowerCase() === one.name.trim().toLowerCase());
  async function addOne() {
    setSaving(true);
    try {
      await api.post("/admin/departments", { ...one, establishment_id: estbId });
      showSuccess(`“${one.name.trim()}” added to ${estbLabel}.`);
      setOne({ name: "", code: "" });
      refresh();
    } catch (err) {
      toast.error(apiErrorDetail(err) ?? "Could not add the department.");
    } finally {
      setSaving(false);
    }
  }

  // Copy from other establishments
  const [pickSearch, setPickSearch] = useState("");
  const [picked, setPicked] = useState<Record<string, string>>({});   // name → optional different code ("" = usual)
  const [picking, setPicking] = useState(false);
  const [pickResult, setPickResult] = useState<PickResult | null>(null);
  const visible = deptNames.filter((n) => n.name.toLowerCase().includes(pickSearch.trim().toLowerCase()));
  const addable = visible.filter((n) => !hasName(n.name));
  const pickedNames = Object.keys(picked);
  const toggle = (name: string) => setPicked((p) => { const c = { ...p }; if (name in c) delete c[name]; else c[name] = ""; return c; });
  const allVisibleTicked = addable.length > 0 && addable.every((n) => n.name in picked);
  const toggleAllVisible = () => setPicked((p) => {
    const c = { ...p };
    if (allVisibleTicked) addable.forEach((n) => delete c[n.name]); else addable.forEach((n) => { if (!(n.name in c)) c[n.name] = ""; });
    return c;
  });
  async function addPicked() {
    setPicking(true);
    setPickResult(null);
    try {
      const res = await api.post("/admin/departments/add-existing", {
        establishment_id: estbId, items: pickedNames.map((name) => ({ name, code: picked[name].trim() || null })),
      });
      const data = res.data as PickResult;
      setPickResult(data);
      setPicked({});
      refresh();
      if (data.failed === 0) showSuccess(`${data.created} department${data.created === 1 ? "" : "s"} added to ${data.establishment}.`);
      else toast.warning(`${data.created} added, ${data.failed} could not be added — see the reasons below.`);
    } catch (err) {
      toast.error(apiErrorDetail(err) ?? "Could not add the departments.");
    } finally {
      setPicking(false);
    }
  }

  // Excel
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
  const problems = result?.results.filter((r) => r.status === "failed") ?? [];
  const rowsToShow = result ? (showAll ? result.results : problems) : [];

  const METHODS: { id: Method; icon: React.ElementType; title: string; text: string }[] = [
    { id: "new", icon: Keyboard, title: "Type a new department", text: "A department no establishment has yet. You give it a name and a code." },
    { id: "copy", icon: ListChecks, title: "Copy from other establishments", text: "Pick departments that already exist elsewhere — one or many. They keep their code unless you type a different one." },
    { id: "excel", icon: FileSpreadsheet, title: "Upload an Excel sheet", text: "Many departments at once (new establishments too), each with its own code." },
  ];
  const needsEstb = method === "new" || method === "copy";

  return (
    <div className="space-y-5">
      {/* Step 1 — how */}
      <div>
        <div className="flex items-center gap-3 mb-3">
          <span className={STEP}>1</span>
          <p className="text-base font-semibold text-gray-800">How do you want to add the department?</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {METHODS.map((m) => (
            <button key={m.id} type="button" onClick={() => setMethod(m.id)}
              className={cn("text-left rounded-xl border-2 p-4 transition-colors",
                method === m.id ? "border-[#0D6E6E] bg-[#F0F7F7]" : "border-gray-200 bg-white hover:border-[#0D6E6E]/50")}>
              <m.icon size={22} className="text-[#0D6E6E] mb-2" />
              <p className="text-sm font-bold text-gray-900">{m.title}</p>
              <p className="text-xs text-gray-500 mt-1 leading-relaxed">{m.text}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Step 2 — which establishment (not needed for Excel: the sheet says it) */}
      {needsEstb && (
        <div>
          <div className="flex items-center gap-3 mb-3">
            <span className={STEP}>2</span>
            <p className="text-base font-semibold text-gray-800">Which establishment is it for?</p>
          </div>
          <div className="max-w-xl">
            <SearchableSelect
              options={establishments.filter((e) => e.is_active).map((e) => ({ value: e.id, label: e.name }))}
              value={estbId} onChange={(v) => { setEstbId(v); setPicked({}); setPickResult(null); }}
              clearable={false} placeholder="Select an establishment…" searchPlaceholder="Search establishments…" />
          </div>
          {estbId && (
            <div className="mt-2 text-xs text-gray-500">
              <b>{estbLabel}</b> already has {inEstb.length} department{inEstb.length === 1 ? "" : "s"}
              {inEstb.length > 0 && <>: {inEstb.map((d) => d.name).join(", ")}</>}
            </div>
          )}
        </div>
      )}

      {/* Step 3 — details */}
      {method && (!needsEstb || estbId) && (
        <div>
          <div className="flex items-center gap-3 mb-3">
            <span className={STEP}>{needsEstb ? 3 : 2}</span>
            <p className="text-base font-semibold text-gray-800">
              {method === "new" ? "Name and code" : method === "copy" ? "Tick the departments to add" : "Upload the sheet"}
            </p>
          </div>

          {method === "new" && (
            <div className="bg-gray-50 rounded-xl border border-gray-200 p-4 grid grid-cols-1 md:grid-cols-[1.4fr_0.8fr_auto] gap-3 items-start">
              <div>
                <label className={LABEL}>Department name *</label>
                <input value={one.name} onChange={(e) => setOne((s) => ({ ...s, name: e.target.value }))} placeholder="e.g. Department of Agronomy"
                  className={cn(INPUT, oneTaken && "border-red-400 focus:ring-red-300")} />
                {oneTaken && <p className="text-xs text-red-600 mt-1">{estbLabel} already has a department called “{one.name.trim()}”.</p>}
                {existsElsewhere && (
                  <p className="text-xs text-amber-700 mt-1">Another establishment already has “{one.name.trim()}”. You can also use “Copy from other establishments” to keep its code.</p>
                )}
              </div>
              <div>
                <label className={LABEL}>Code * <span className="font-normal text-gray-400">(used in file numbers)</span></label>
                <input value={one.code} onChange={(e) => setOne((s) => ({ ...s, code: e.target.value.toUpperCase().slice(0, 20) }))} placeholder="e.g. AGRO" className={cn(INPUT, "font-mono")} />
              </div>
              <div className="md:pt-7">
                <button type="button" onClick={addOne} disabled={saving || !one.name.trim() || !one.code.trim() || oneTaken} className={BTN}>
                  {saving ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Add to {estbLabel}
                </button>
              </div>
            </div>
          )}

          {method === "copy" && (
            <div className="bg-gray-50 rounded-xl border border-gray-200 p-4">
              <div className="flex flex-wrap items-center gap-3 mb-2">
                <input value={pickSearch} onChange={(e) => setPickSearch(e.target.value)} placeholder="Search departments…"
                  className="flex-1 min-w-[200px] border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]" />
                <button type="button" onClick={toggleAllVisible} disabled={addable.length === 0}
                  className="px-3 py-2.5 border border-gray-300 bg-white rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-100 disabled:opacity-50 whitespace-nowrap">
                  {allVisibleTicked ? "Untick all shown" : `Tick all shown (${addable.length})`}
                </button>
              </div>
              <div className="max-h-80 overflow-y-auto bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
                {visible.length === 0 && (
                  <p className="text-sm text-gray-400 px-3 py-6 text-center">
                    {deptNames.length === 0 ? "No departments exist yet — use “Type a new department”." : "No department matches your search."}
                  </p>
                )}
                {visible.map((n) => {
                  const already = hasName(n.name);
                  const on = n.name in picked;
                  const where = n.establishment_ids.map((id) => estbNameById.get(id)).filter(Boolean) as string[];
                  return (
                    <div key={n.name} className={cn("px-3 py-2.5", already && "bg-gray-50", on && "bg-[#F4FAF9]")}>
                      <label className={cn("flex items-start gap-3", already ? "cursor-not-allowed" : "cursor-pointer")}>
                        <input type="checkbox" disabled={already} checked={on} onChange={() => toggle(n.name)} className="accent-[#0D6E6E] w-4 h-4 mt-1 shrink-0" />
                        <span className="flex-1 min-w-0">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className={cn("text-sm font-semibold", already ? "text-gray-400" : "text-gray-900")}>{n.name}</span>
                            {n.codes.length > 0 && (
                              <span className="text-xs font-mono font-semibold text-[#0A5757] bg-[#E6F4F4] border border-[#BFDEDB] rounded px-1.5 py-0.5">
                                {n.codes.length === 1 ? `Code ${n.codes[0]}` : `Codes ${n.codes.join(", ")}`}
                              </span>
                            )}
                            {already && <span className="text-xs font-semibold text-gray-500 flex items-center gap-1"><Lock size={11} /> Already in {estbLabel}</span>}
                          </span>
                          <span className="block text-xs text-gray-500 mt-0.5 truncate" title={where.join(", ")}>
                            In {n.count} establishment{n.count === 1 ? "" : "s"}{where.length ? `: ${where.slice(0, 3).join(", ")}${where.length > 3 ? ` +${where.length - 3} more` : ""}` : ""}
                          </span>
                        </span>
                      </label>
                      {on && (
                        <div className="ml-7 mt-2 flex flex-wrap items-center gap-2">
                          <label className="text-xs font-semibold text-gray-600">Different code <span className="font-normal text-gray-400">(optional)</span></label>
                          <input value={picked[n.name]} maxLength={50} onChange={(e) => setPicked((p) => ({ ...p, [n.name]: e.target.value.toUpperCase() }))}
                            placeholder={n.code ? `empty = ${n.code}` : "code"}
                            className="w-44 border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm font-mono bg-white focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button type="button" onClick={addPicked} disabled={pickedNames.length === 0 || picking} className={BTN}>
                  {picking ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                  {pickedNames.length ? `Add ${pickedNames.length} to ${estbLabel}` : "Tick departments to add"}
                </button>
                {pickedNames.length > 0 && <button type="button" onClick={() => setPicked({})} className="text-xs font-semibold text-gray-500 hover:underline">Clear selection</button>}
              </div>
              {pickResult && (
                <div className="mt-3 border border-gray-200 rounded-lg bg-white divide-y divide-gray-100">
                  {pickResult.results.map((r) => (
                    <div key={r.name} className="flex items-start gap-3 px-3 py-2 text-sm">
                      {r.status === "created" ? <CheckCircle2 size={16} className="text-emerald-600 shrink-0 mt-0.5" />
                        : r.status === "skipped" ? <MinusCircle size={16} className="text-gray-400 shrink-0 mt-0.5" />
                        : <XCircle size={16} className="text-red-500 shrink-0 mt-0.5" />}
                      <div className="min-w-0">
                        <p className="font-medium text-gray-900">{r.name}{r.code ? <span className="ml-2 text-xs font-mono text-[#0A5757]">Code {r.code}</span> : null}</p>
                        <p className={cn("text-xs", r.status === "failed" ? "text-red-600" : "text-gray-500")}>{r.status === "created" ? "Added." : r.note}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {method === "excel" && (
            <div className="bg-gray-50 rounded-xl border border-gray-200 p-4 space-y-3">
              <ol className="text-sm text-gray-700 space-y-1 list-decimal ml-5">
                <li>Download the template and fill one row per department: <b>Establishment Name, Establishment Code, Department Name, Department Code</b>.</li>
                <li>A new establishment is created automatically. A department an establishment already has is skipped.</li>
                <li>Choose the file and click Upload — every row gets a clear result.</li>
              </ol>
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={downloadTemplate} disabled={downloading}
                  className="flex items-center gap-1.5 px-3 py-2.5 bg-white border border-gray-300 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-100 disabled:opacity-50">
                  {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Download template
                </button>
                <input key={fileKey} type="file" accept=".xlsx,.csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); }}
                  className="block flex-1 min-w-[240px] text-sm text-gray-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-gray-200 file:text-gray-700 file:font-semibold hover:file:bg-gray-300" />
                <button type="button" onClick={upload} disabled={!file || uploading} className={BTN}>
                  {uploading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} Upload
                </button>
              </div>
              {result && (
                <div>
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
          )}
        </div>
      )}
    </div>
  );
}

/** The creation section in a pop-up — opened from an establishment's box. */
export function CreateDepartmentModal({ establishmentId, establishmentName, onClose }: { establishmentId: string; establishmentName: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center overflow-y-auto p-6" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900">Add department to {establishmentName}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="px-6 py-5"><CreateDepartmentPanel initialEstablishmentId={establishmentId} /></div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end">
          <button onClick={onClose} className="px-4 py-2.5 rounded-lg text-sm font-semibold text-gray-700 border border-gray-200 hover:bg-gray-50">Done</button>
        </div>
      </div>
    </div>
  );
}

// ── Departments tab ──────────────────────────────────────────────────────────

export function DepartmentManagementSection() {
  const { establishments, departments, refresh } = useOrgData();
  const [view, setView] = useState<"list" | "create">("list");
  const [editing, setEditing] = useState<Department | null>(null);

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
  // One card per department name (any case); every place it exists is a line inside.
  const nameKey = (n: string) => n.trim().toLowerCase();
  const totalPlaces = useMemo(() => {
    const m = new Map<string, number>();
    departments.forEach((d) => m.set(nameKey(d.name), (m.get(nameKey(d.name)) ?? 0) + 1));
    return m;
  }, [departments]);
  const allGroupCount = totalPlaces.size;
  const groups = useMemo(() => {
    const m = new Map<string, { key: string; name: string; rows: Department[] }>();
    shown.forEach((d) => {
      const g = m.get(nameKey(d.name)) ?? { key: nameKey(d.name), name: d.name.trim(), rows: [] };
      g.rows.push(d);
      m.set(g.key, g);
    });
    return Array.from(m.values())
      .map((g) => ({ ...g, rows: g.rows.sort((a, b) => (estbName.get(a.establishment_id ?? "") ?? "").localeCompare(estbName.get(b.establishment_id ?? "") ?? "")) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [shown, estbName]);

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

  // ── Remove (one or several) ──
  const [removeIds, setRemoveIds] = useState<string[]>([]);
  const [removing, setRemoving] = useState(false);
  async function removeDepartments(list: Department[]) {
    if (list.length === 0) return;
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const ok = await confirmAction({
      title: list.length === 1 ? "Remove this department?" : `Remove ${list.length} departments?`,
      html: `<div style="text-align:left;font-size:14px;line-height:1.5">
        <ul style="margin:0 0 8px 18px;list-style:disc;max-height:180px;overflow:auto">${list.map((d) => `<li><b>${esc(d.name)}</b>${d.establishment_id ? ` — from <b>${esc(estbName.get(d.establishment_id) ?? "")}</b> only` : ""}${d.code ? ` <span style="color:#6B7280">(code ${esc(d.code)})</span>` : ""}</li>`).join("")}</ul>
        <p>They will be removed permanently. A department that people or files still use is <b>not</b> removed — you will see why.</p></div>`,
      confirmText: "Remove", danger: true,
    });
    if (!ok) return;
    setRemoving(true);
    try {
      const res = await api.post("/admin/departments/remove", { ids: list.map((d) => d.id) });
      const data = res.data as { removed: number; blocked: number; results: { name: string; establishment: string | null; status: string; reasons: string[] }[] };
      setRemoveIds([]);
      refresh();
      if (data.blocked === 0) {
        showSuccess(`${data.removed} department${data.removed === 1 ? "" : "s"} removed.`);
      } else {
        const lines = data.results.filter((r) => r.status === "blocked")
          .map((r) => `“${r.name}”${r.establishment ? ` (${r.establishment})` : ""} was not removed:\n${r.reasons.map((x) => `• ${x}`).join("\n")}`);
        await showBlocked(`${data.removed} removed, ${data.blocked} could not be removed.\n\n${lines.join("\n\n")}\n\nYou can hide a department instead (the eye icon) — that keeps everything intact.`, "Some departments were not removed");
      }
    } catch (err) {
      toast.error(apiErrorDetail(err) ?? "Could not remove the departments.");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Two sections: the list, and creating new ones */}
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200">
        <button type="button" onClick={() => setView("list")}
          className={cn("px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px", view === "list" ? "border-[#0D6E6E] text-[#0D6E6E]" : "border-transparent text-gray-500 hover:text-gray-700")}>
          All departments
        </button>
        <button type="button" onClick={() => setView("create")}
          className={cn("px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px flex items-center gap-1.5", view === "create" ? "border-[#0D6E6E] text-[#0D6E6E]" : "border-transparent text-gray-500 hover:text-gray-700")}>
          <Plus size={15} /> Create new department
        </button>
      </div>

      {view === "create" ? (
        <div>
          <button type="button" onClick={() => setView("list")} className="mb-4 flex items-center gap-1 text-sm text-[#0D6E6E] hover:underline"><ArrowLeft size={14} /> Back to all departments</button>
          <CreateDepartmentPanel />
        </div>
      ) : (
        <>
      {/* List — one card per department; the establishments that have it, with each one's code */}
      <div>
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <p className="text-sm font-semibold text-gray-700 mr-auto">
            Departments ({groups.length}{groups.length !== allGroupCount ? ` of ${allGroupCount}` : ""}) · {shown.length} place{shown.length === 1 ? "" : "s"}
          </p>
          <div className="w-64">
            <SearchableSelect options={establishments.map((e) => ({ value: e.id, label: e.name }))} value={filterEstb} onChange={setFilterEstb}
              placeholder="All establishments" searchPlaceholder="Search establishments…" />
          </div>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, code or establishment…"
            className="w-64 border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]" />
        </div>
        {shown.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 mb-2 px-1">
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
              <input type="checkbox" className="accent-[#0D6E6E] w-4 h-4"
                checked={shown.every((d) => removeIds.includes(d.id))}
                onChange={(e) => setRemoveIds((cur) => e.target.checked ? Array.from(new Set([...cur, ...shown.map((d) => d.id)])) : cur.filter((id) => !shown.some((d) => d.id === id)))} />
              Select every place shown
            </label>
            {removeIds.length > 0 && (
              <>
                <button type="button" disabled={removing}
                  onClick={() => removeDepartments(departments.filter((d) => removeIds.includes(d.id)))}
                  className="flex items-center gap-1.5 px-3 py-2 bg-red-600 text-white rounded-lg text-sm font-semibold hover:bg-red-700 disabled:opacity-50">
                  {removing ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Remove {removeIds.length} selected
                </button>
                <button type="button" onClick={() => setRemoveIds([])} className="text-xs font-semibold text-gray-500 hover:underline">Clear selection</button>
              </>
            )}
          </div>
        )}
        {groups.length === 0 && <p className="text-sm text-gray-400 py-8 text-center">No departments{search || filterEstb ? " match" : " yet"}.</p>}
        {groups.map((g) => {
          const total = totalPlaces.get(g.key) ?? g.rows.length;
          const allTicked = g.rows.every((d) => removeIds.includes(d.id));
          return (
            <div key={g.key} className="bg-white border border-gray-200 rounded-xl mb-3 overflow-hidden">
              <div className="flex flex-wrap items-center gap-3 px-4 py-3 bg-gray-50 border-b border-gray-100">
                <input type="checkbox" className="accent-[#0D6E6E] w-4 h-4 shrink-0" aria-label={`Select every place of ${g.name}`} checked={allTicked}
                  onChange={(e) => setRemoveIds((cur) => e.target.checked ? Array.from(new Set([...cur, ...g.rows.map((d) => d.id)])) : cur.filter((id) => !g.rows.some((d) => d.id === id)))} />
                <div className="min-w-0 flex-1">
                  <p className="text-base font-semibold text-gray-900 truncate">{g.name}</p>
                  <p className="text-xs text-gray-500">
                    In {total} establishment{total === 1 ? "" : "s"}
                    {total !== g.rows.length ? ` · showing ${g.rows.length}` : ""}
                  </p>
                </div>
                {total > 1 && (
                  <span className="text-xs text-gray-500">Remove it from just some of them — tick the ones, then <b>Remove selected</b>.</span>
                )}
              </div>
              <div className="divide-y divide-gray-100">
                {g.rows.map((d) => (
                  <div key={d.id} className={cn("flex items-center gap-3 px-4 py-2.5", !d.is_active && "bg-gray-50 opacity-70", removeIds.includes(d.id) && "bg-red-50/60")}>
                    <input type="checkbox" className="accent-[#0D6E6E] w-4 h-4 shrink-0" aria-label={`Select ${d.name} in ${estbName.get(d.establishment_id ?? "") ?? "no establishment"}`}
                      checked={removeIds.includes(d.id)} onChange={() => setRemoveIds((cur) => cur.includes(d.id) ? cur.filter((x) => x !== d.id) : [...cur, d.id])} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 truncate">{estbName.get(d.establishment_id ?? "") ?? "No establishment"}</p>
                      {!d.is_active && <span className="text-xs text-amber-600 font-medium">Hidden</span>}
                    </div>
                    <span className="text-xs font-mono font-semibold text-[#0A5757] bg-[#E6F4F4] border border-[#BFDEDB] rounded px-2 py-1 whitespace-nowrap">
                      {d.code ? `Code ${d.code}` : "No code"}
                    </span>
                    <div className="flex gap-1 shrink-0">
                      <button onClick={() => setEditing(d)} title="Edit name or code"
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-[#0D6E6E] border border-[#BFDEDB] hover:bg-[#F0F7F7]"><Pencil size={13} /> Edit</button>
                      <button onClick={() => act(() => api.patch(`/admin/departments/${d.id}/toggle`, {}))} title={d.is_active ? "Hide" : "Show"}
                        className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">{d.is_active ? <Eye size={16} /> : <EyeOff size={16} />}</button>
                      <button onClick={() => removeDepartments([d])} title={`Remove from ${estbName.get(d.establishment_id ?? "") ?? "this establishment"} only`}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-red-600 border border-red-200 hover:bg-red-50"><Trash2 size={14} /> Remove</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
        </>
      )}

      {editing && (
        <EditNameCodeModal
          title="Edit department"
          hint={`${editing.name} in ${estbName.get(editing.establishment_id ?? "") ?? "—"}. A new code is used for new file numbers; existing file numbers stay as they are.`}
          name={editing.name} code={editing.code}
          onSave={async (name, code) => { await api.patch(`/admin/departments/${editing.id}`, { name, code }); refresh(); showSuccess("Department updated."); }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
