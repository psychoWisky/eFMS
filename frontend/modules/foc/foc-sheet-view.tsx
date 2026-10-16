"use client";
// One FOC on the AVFU letterhead. The in-charge fills in the amount required,
// sanction order no., sanction document, purpose and remark of each line,
// certifies and sends it to a DDO; the officer holding it approves, returns
// (remark required) or forwards it; once approved anyone involved can
// download the PDF. Everyone else involved sees it read-only.
import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft, ArrowRight, CheckCircle2, Download, FileText, Loader2, Paperclip, RotateCcw, Save, Send, Trash2, Upload, XCircle,
} from "lucide-react";
import { api } from "@/services/api";
import { cn } from "@/lib/utils";
import { confirmAction, showSuccess } from "@/lib/alert";
import { SearchableSelect } from "@/components/shared/searchable-select";
import {
  STATUS_BADGE, apiDetail, formatFocDate, formatINR, openFocBlob, personLabel,
  type FocLine, type FocPerson, type FocSheet,
} from "@/lib/foc";

type Entry = { amount_required: string; sanction_order_no: string; purpose: string; remark: string };

function entriesFrom(sheet: FocSheet): Record<string, Entry> {
  return Object.fromEntries(sheet.lines.map((l) => [l.id, {
    amount_required: parseFloat(l.amount_required) ? l.amount_required : "",
    sanction_order_no: l.sanction_order_no ?? "",
    purpose: l.purpose ?? "",
    remark: l.remark ?? "",
  }]));
}

const DOC_ACCEPT = ".pdf,.jpg,.jpeg,.png,.doc,.docx";

// ── Amount in words (Indian numbering), same as the server's PDF ───────────
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
  "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const two = (n: number) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : ""));
const three = (n: number) => [Math.floor(n / 100) ? `${ONES[Math.floor(n / 100)]} Hundred` : "", n % 100 ? two(n % 100) : ""].filter(Boolean).join(" ");
function wholeWords(n: number): string {
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7), lakh = Math.floor((n % 1e7) / 1e5), thousand = Math.floor((n % 1e5) / 1000), rest = n % 1000;
  if (crore) parts.push(`${crore > 999 ? wholeWords(crore) : three(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (rest) parts.push(three(rest));
  return parts.join(" ");
}
export function rupeesInWords(total: number): string {
  const paiseTotal = Math.round(total * 100);
  const rupees = Math.floor(paiseTotal / 100), paise = paiseTotal % 100;
  if (!rupees && !paise) return "Zero Rupees Only";
  let out = rupees ? `${wholeWords(rupees)} Rupees` : "";
  if (paise) out = out ? `${out} and ${two(paise)} Paise` : `${two(paise)} Paise`;
  return `${out} Only`;
}

function Letterhead() {
  return (
    <div>
      <div className="flex items-center gap-3">
        <Image src="/avfu_letterhead_logo.png" alt="AVFU" width={84} height={84} className="shrink-0" />
        <div className="flex-1 text-center pr-6">
          <p className="text-[18px] font-bold text-[#0A5757] leading-snug" lang="as">অসম পশু চিকিৎসা আৰু মীন বিশ্ববিদ্যালয়</p>
          <p className="text-[16px] font-bold tracking-wide text-[#0A5757]">ASSAM VETERINARY AND FISHERY UNIVERSITY</p>
          <p className="text-[11.5px] font-bold tracking-wider text-[#4A4A4A] mt-0.5">KHANAPARA, GUWAHATI, ASSAM – 781022</p>
        </div>
      </div>
      <div className="border-t-[2.5px] border-[#0D6E6E] mt-2" />
      <div className="border-t-[0.75px] border-[#C6902B] mt-[2px]" />
    </div>
  );
}

function InfoGrid({ rows }: { rows: [string, string | null | undefined, string, string | null | undefined][] }) {
  return (
    <table className="w-full border-collapse text-[13px]">
      <tbody>
        {rows.map(([k1, v1, k2, v2]) => (
          <tr key={k1}>
            <td className="border border-[#BFDEDB] bg-[#EEF6F5] text-[#0A5757] font-bold px-2.5 py-1.5 w-[19%] align-top">{k1}</td>
            <td className="border border-[#BFDEDB] px-2.5 py-1.5 align-top">{v1 || "—"}</td>
            <td className="border border-[#BFDEDB] bg-[#EEF6F5] text-[#0A5757] font-bold px-2.5 py-1.5 w-[19%] align-top">{k2}</td>
            <td className="border border-[#BFDEDB] px-2.5 py-1.5 align-top">{v2 || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const SECTION = "text-[11px] font-bold tracking-[1px] text-[#0A5757] uppercase mt-6 mb-2";
const CELL_INPUT = "w-full border border-gray-300 rounded-md px-2 py-1 text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]";
const ACTION_TEXT: Record<string, string> = { submitted: "Sent", forwarded: "Forwarded", approved: "Approved", rejected: "Returned" };

export function FocSheetView({ sheetId }: { sheetId: string }) {
  const qc = useQueryClient();
  const { data: sheet, isLoading, isError, error } = useQuery<FocSheet>({
    queryKey: ["foc-sheet", sheetId],
    queryFn: () => api.get(`/foc/sheets/${sheetId}`).then((r) => r.data),
    retry: false,
  });

  // Local edits. Re-seeded from the server only when the sheet first loads
  // and after a save / send — never from a background refetch, so typing is
  // never thrown away.
  const [entries, setEntries] = useState<Record<string, Entry> | null>(null);
  const [baseline, setBaseline] = useState<Record<string, Entry> | null>(null);
  const [certified, setCertified] = useState(false);
  const [ddoId, setDdoId] = useState("");
  const [sendRemark, setSendRemark] = useState("");
  const [officerRemark, setOfficerRemark] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  if (sheet && entries === null) {
    // First load: seed the form (state set during render, not in an effect).
    const e = entriesFrom(sheet);
    setEntries(e);
    setBaseline(e);
  }

  const { data: ddos = [] } = useQuery<FocPerson[]>({
    queryKey: ["foc-ddos"],
    queryFn: () => api.get("/foc/ddos").then((r) => r.data),
    enabled: !!sheet?.can_submit,
  });

  const dirty = !!entries && !!baseline && JSON.stringify(entries) !== JSON.stringify(baseline);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const total = useMemo(() => {
    if (!sheet) return 0;
    if (!entries || !sheet.can_edit) return parseFloat(sheet.total_required) || 0;
    return sheet.lines.reduce((sum, l) => sum + (parseFloat(entries[l.id]?.amount_required || "0") || 0), 0);
  }, [sheet, entries]);

  const overLimit = (l: FocLine) => {
    const v = parseFloat(entries?.[l.id]?.amount_required || "0");
    return Number.isFinite(v) && (v < 0 || v > parseFloat(l.available_fund));
  };

  function applyServer(next: FocSheet) {
    qc.setQueryData(["foc-sheet", sheetId], next);
    const e = entriesFrom(next);
    setEntries(e);
    setBaseline(e);
    qc.invalidateQueries({ queryKey: ["foc-docket"] });
    qc.invalidateQueries({ queryKey: ["foc-mine"] });
    qc.invalidateQueries({ queryKey: ["foc-history"] });
  }

  async function saveEntries(quiet = false): Promise<FocSheet | null> {
    if (!sheet || !entries) return null;
    const bad = sheet.lines.find(overLimit);
    if (bad) { toast.error(`Line ${bad.sl_no} (${bad.sub_head}): the amount required is more than the available fund.`); return null; }
    try {
      const r = await api.put(`/foc/sheets/${sheetId}/entries`, sheet.lines.map((l) => ({
        line_id: l.id,
        amount_required: entries[l.id].amount_required || "0",
        sanction_order_no: entries[l.id].sanction_order_no,
        purpose: entries[l.id].purpose,
        remark: entries[l.id].remark,
      })));
      applyServer(r.data);
      setCertified(false);
      if (!quiet) showSuccess("FOC saved.");
      return r.data;
    } catch (err) {
      toast.error(apiDetail(err, "Could not save the FOC."));
      return null;
    }
  }

  async function handleSave() {
    setBusy("save");
    await saveEntries();
    setBusy(null);
  }

  async function handleProceed() {
    if (!sheet) return;
    if (!certified) { toast.error("Please tick the certificate first."); return; }
    if (!ddoId) { toast.error("Choose the DDO to send this FOC to."); return; }
    if (total <= 0) { toast.error("Enter the amount required on at least one line."); return; }
    const ddo = ddos.find((d) => d.id === ddoId);
    const ok = await confirmAction({
      title: "Send this FOC?",
      text: `FOC #${sheet.number} (₹ ${formatINR(total)}) will be sent to ${personLabel(ddo)}. You cannot change it while it is with the officers.`,
      confirmText: "Send",
    });
    if (!ok) return;
    setBusy("submit");
    try {
      if (dirty && !(await saveEntries(true))) return;
      const r = await api.post(`/foc/sheets/${sheetId}/submit`, { ddo_user_id: ddoId, certified: true, remark: sendRemark || null });
      applyServer(r.data);
      setSendRemark("");
      showSuccess(`FOC sent to ${ddo?.full_name ?? "the DDO"}.`);
    } catch (err) {
      toast.error(apiDetail(err, "Could not send the FOC."));
    } finally {
      setBusy(null);
    }
  }

  const act = useMutation({
    mutationFn: async (kind: "approve" | "reject" | "forward") =>
      (await api.post(`/foc/sheets/${sheetId}/${kind}`, { remark: officerRemark.trim() || null })).data as FocSheet,
    onSuccess: (data, kind) => {
      applyServer(data);
      setOfficerRemark("");
      showSuccess(kind === "approve" ? "FOC approved." : kind === "reject" ? "FOC returned to the in-charge." : `FOC forwarded to the ${data.stage_title}.`);
    },
    onError: (err) => toast.error(apiDetail(err, "Could not complete the action.")),
  });

  async function officerAction(kind: "approve" | "reject" | "forward") {
    if (!sheet) return;
    if (kind === "reject" && !officerRemark.trim()) { toast.error("Write a remark explaining why the FOC is being returned."); return; }
    const ok = await confirmAction({
      title: kind === "approve" ? "Approve this FOC?" : kind === "reject" ? "Return this FOC to the in-charge?" : `Forward to the ${sheet.forward_to_title}?`,
      text: kind === "approve"
        ? "Approval is final. The in-charge will be able to download the approved FOC."
        : kind === "reject" ? "The in-charge will see your remark, correct the FOC and send it again." : undefined,
      confirmText: kind === "approve" ? "Approve" : kind === "reject" ? "Return" : "Forward",
      danger: kind === "reject",
    });
    if (ok) act.mutate(kind);
  }

  async function uploadDoc(line: FocLine, file: File) {
    if (dirty) {
      // An upload refreshes the sheet; save the typing first so it is kept.
      if (!(await saveEntries(true))) return;
    }
    setBusy(`doc-${line.id}`);
    try {
      const form = new FormData();
      form.append("upload", file, file.name);
      await api.post(`/foc/sheets/${sheetId}/lines/${line.id}/document`, form, { headers: { "Content-Type": "multipart/form-data" } });
      const fresh = (await api.get(`/foc/sheets/${sheetId}`)).data as FocSheet;
      applyServer(fresh);
      setCertified(false);
      toast.success(`“${file.name}” attached to line ${line.sl_no}.`);
    } catch (err) {
      toast.error(apiDetail(err, "Could not upload the document."));
    } finally {
      setBusy(null);
    }
  }

  async function removeDoc(line: FocLine) {
    const ok = await confirmAction({ title: "Remove this document?", text: `“${line.document?.name}” will be removed from line ${line.sl_no}.`, confirmText: "Remove", danger: true });
    if (!ok) return;
    if (dirty && !(await saveEntries(true))) return;
    setBusy(`doc-${line.id}`);
    try {
      await api.delete(`/foc/sheets/${sheetId}/lines/${line.id}/document`);
      applyServer((await api.get(`/foc/sheets/${sheetId}`)).data);
      setCertified(false);
    } catch (err) {
      toast.error(apiDetail(err, "Could not remove the document."));
    } finally {
      setBusy(null);
    }
  }

  async function openDoc(line: FocLine) {
    if (!line.document) return;
    try { await openFocBlob(line.document.url, line.document.name, false); }
    catch (err) { toast.error((err as Error).message); }
  }

  async function downloadPdf() {
    if (!sheet) return;
    setBusy("pdf");
    try {
      await openFocBlob(`/foc/sheets/${sheetId}/pdf`, `FOC-${sheet.number}-${sheet.name.replace(/[^A-Za-z0-9._-]+/g, "-")}.pdf`, true);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (isLoading) return <div className="flex items-center justify-center py-24 gap-3 text-gray-400"><Loader2 className="animate-spin" /> Loading FOC…</div>;
  if (isError || !sheet) {
    return (
      <div className="flex flex-col items-center py-24 text-gray-500">
        <XCircle size={40} className="mb-3 text-red-300" />
        <p className="text-lg font-semibold">{apiDetail(error, "FOC not found.")}</p>
        <Link href="/foc" className="mt-4 text-[#0D6E6E] hover:underline text-sm">← FOC Docket</Link>
      </div>
    );
  }

  const p = sheet.project;
  const office = [p.establishment_name, p.department_name].filter(Boolean).join(" / ") || "—";
  const editing = sheet.can_edit && !!entries;
  const lastReturn = [...sheet.movements].reverse().find((m) => m.action === "rejected");
  const approval = [...sheet.movements].reverse().find((m) => m.action === "approved");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/foc" className="flex items-center gap-1.5 text-sm text-[#0D6E6E] hover:underline"><ArrowLeft size={15} /> FOC Docket</Link>
        <div className="flex items-center gap-2">
          <span className={cn("px-3 py-1 rounded-full text-xs font-bold border", STATUS_BADGE[sheet.status])}>{sheet.status_label}</span>
          {sheet.can_download && (
            <button onClick={downloadPdf} disabled={busy === "pdf"}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold bg-[#0D6E6E] text-white hover:bg-[#178F8F] disabled:opacity-50">
              {busy === "pdf" ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Download PDF
            </button>
          )}
        </div>
      </div>

      {sheet.status === "rejected" && lastReturn && (
        <div className="bg-red-50 border border-red-200 rounded-2xl px-5 py-4">
          <p className="text-sm font-bold text-red-800 flex items-center gap-2"><RotateCcw size={15} /> Returned by {personLabel(lastReturn.from_user)} — {lastReturn.from_stage_title}, {formatFocDate(lastReturn.created_at)}</p>
          <p className="text-sm text-red-900 mt-1 whitespace-pre-wrap">{lastReturn.remark}</p>
          {sheet.can_edit && <p className="text-xs text-red-700 mt-2">Correct the FOC below and send it again — it starts again from a DDO.</p>}
        </div>
      )}
      {sheet.status === "pending" && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl px-5 py-3 text-sm text-amber-900">
          {sheet.can_act ? <b>This FOC is waiting for your action as {sheet.stage_title}.</b>
            : <>With <b>{personLabel(sheet.holder)}</b> ({sheet.stage_title}) since {formatFocDate(sheet.movements.at(-1)?.created_at)}.</>}
        </div>
      )}
      {sheet.status === "approved" && approval && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl px-5 py-3 text-sm text-emerald-900 flex items-center gap-2">
          <CheckCircle2 size={16} /> Approved by <b>{personLabel(approval.from_user)}</b> — {approval.from_stage_title}, {formatFocDate(approval.created_at)}
          {approval.remark && <span className="text-emerald-800">· “{approval.remark}”</span>}
        </div>
      )}

      {/* The FOC on the letterhead */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 sm:p-8 text-[#1A1A1A]">
        <Letterhead />
        <p className="text-center text-[13px] font-bold tracking-[4px] text-[#0A5757] uppercase mt-4">Fixation of Ceiling</p>
        <p className="text-center text-[13px] font-bold">{office}</p>
        <p className="text-center text-[11px] text-gray-500 mb-4">FOC No. {sheet.number} · Financial Year {sheet.financial_year}</p>

        <InfoGrid rows={[
          ["Name of the Project", p.name, "Funded By", p.funded_by],
          ["Funding Agency", p.funding_agency, "F.O.C. Creation Date", formatFocDate(sheet.created_at, false)],
          ["F.O.C. Received From", personLabel(sheet.incharge), "Project P.I. Name", p.pi_name],
          ["Type of Project", p.project_type, "Financial Year", sheet.financial_year],
          ["F.O.C. Name", sheet.name, "Fund Sanction Remittance No.", p.fund_sanction_remittance_no],
        ]} />

        <p className={SECTION}>Fund requirement</p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px] min-w-[1050px]">
            <thead>
              <tr className="bg-[#0D6E6E] text-white text-[11px] uppercase tracking-wide">
                {["Sl No", "Sub Head", `Sanctioned Fund (FY ${sheet.financial_year})`, "Available Fund", "Amount Required", "Sanction Order No.", "Sanction Document", "Purpose", "Remark"].map((h) => (
                  <th key={h} className="border border-[#BFDEDB] px-2 py-2 text-left font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.lines.map((l) => {
                const e = entries?.[l.id];
                const set = (k: keyof Entry) => (ev: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                  setEntries((prev) => (prev ? { ...prev, [l.id]: { ...prev[l.id], [k]: ev.target.value } } : prev));
                return (
                  <tr key={l.id} className="align-top">
                    <td className="border border-[#BFDEDB] px-2 py-1.5 text-center">{l.sl_no}</td>
                    <td className="border border-[#BFDEDB] px-2 py-1.5 font-semibold">{l.sub_head}</td>
                    <td className="border border-[#BFDEDB] px-2 py-1.5 text-right font-mono whitespace-nowrap">{formatINR(l.sanctioned_fund)}</td>
                    <td className="border border-[#BFDEDB] px-2 py-1.5 text-right font-mono whitespace-nowrap">{formatINR(l.available_fund)}</td>
                    <td className="border border-[#BFDEDB] px-2 py-1.5 w-36">
                      {editing && e ? (
                        <>
                          <input type="number" min={0} step="0.01" max={l.available_fund} value={e.amount_required} onChange={set("amount_required")}
                            placeholder="0.00" className={cn(CELL_INPUT, "text-right font-mono", overLimit(l) && "border-red-500 ring-1 ring-red-400")} />
                          {overLimit(l) && <p className="text-[11px] text-red-600 mt-0.5">More than available</p>}
                        </>
                      ) : <span className="block text-right font-mono font-semibold">{formatINR(l.amount_required)}</span>}
                    </td>
                    <td className="border border-[#BFDEDB] px-2 py-1.5 w-40">
                      {editing && e ? <input value={e.sanction_order_no} onChange={set("sanction_order_no")} maxLength={200} className={CELL_INPUT} />
                        : (l.sanction_order_no || "—")}
                    </td>
                    <td className="border border-[#BFDEDB] px-2 py-1.5 w-44">
                      {l.document ? (
                        <div className="flex items-start gap-1.5">
                          <button type="button" onClick={() => openDoc(l)} title="Open the document"
                            className="flex items-start gap-1 text-left text-[#0D6E6E] hover:underline min-w-0">
                            <Paperclip size={13} className="shrink-0 mt-0.5" /><span className="break-all">{l.document.name}</span>
                          </button>
                          {editing && (
                            <button type="button" onClick={() => removeDoc(l)} disabled={busy === `doc-${l.id}`} title="Remove the document"
                              className="text-red-500 hover:text-red-700 shrink-0 disabled:opacity-50"><Trash2 size={13} /></button>
                          )}
                        </div>
                      ) : editing ? (
                        <label className={cn("flex items-center gap-1.5 cursor-pointer text-xs text-gray-500 hover:text-[#0D6E6E] border border-dashed border-gray-300 hover:border-[#0D6E6E] rounded-md px-2 py-1.5",
                          busy === `doc-${l.id}` && "opacity-50 pointer-events-none")}>
                          {busy === `doc-${l.id}` ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Upload
                          <input type="file" accept={DOC_ACCEPT} className="sr-only" onChange={(ev) => {
                            const f = ev.target.files?.[0];
                            ev.target.value = "";
                            if (f) void uploadDoc(l, f);
                          }} />
                        </label>
                      ) : <span className="text-gray-400">—</span>}
                    </td>
                    <td className="border border-[#BFDEDB] px-2 py-1.5 min-w-[180px]">
                      {editing && e ? <textarea value={e.purpose} onChange={set("purpose")} rows={2} maxLength={2000} className={cn(CELL_INPUT, "resize-y")} />
                        : <span className="whitespace-pre-wrap">{l.purpose || "—"}</span>}
                    </td>
                    <td className="border border-[#BFDEDB] px-2 py-1.5 min-w-[160px]">
                      {editing && e ? <textarea value={e.remark} onChange={set("remark")} rows={2} maxLength={2000} className={cn(CELL_INPUT, "resize-y")} />
                        : <span className="whitespace-pre-wrap">{l.remark || "—"}</span>}
                    </td>
                  </tr>
                );
              })}
              <tr className="bg-[#EEF6F5] font-bold">
                <td colSpan={4} className="border border-[#BFDEDB] px-2 py-2">Total Amount Required: <span className="font-semibold italic">{rupeesInWords(total)}</span></td>
                <td className="border border-[#BFDEDB] px-2 py-2 text-right font-mono whitespace-nowrap">₹ {formatINR(total)}</td>
                <td colSpan={4} className="border border-[#BFDEDB]" />
              </tr>
            </tbody>
          </table>
        </div>

        <p className={SECTION}>Bank and fund information</p>
        <InfoGrid rows={[
          ["Account Holder", p.bank_account_holder, "Bank", p.bank_name],
          ["Account No.", p.bank_account_no, "Fund Received Instrument No.", p.fund_instrument_no],
          ["Fund Received Date", formatFocDate(p.fund_received_date, false), "Establishment / Office", office],
        ]} />

        {sheet.movements.length > 0 && (
          <>
            <p className={SECTION}>Movement</p>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[12.5px]">
                <thead>
                  <tr className="bg-[#0D6E6E] text-white text-[11px] uppercase tracking-wide">
                    {["Date", "Action", "By", "To", "Remark"].map((h) => <th key={h} className="border border-[#BFDEDB] px-2 py-1.5 text-left font-semibold">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {sheet.movements.map((m, i) => (
                    <tr key={i} className="align-top">
                      <td className="border border-[#BFDEDB] px-2 py-1.5 whitespace-nowrap">{formatFocDate(m.created_at)}</td>
                      <td className={cn("border border-[#BFDEDB] px-2 py-1.5 font-semibold",
                        m.action === "approved" ? "text-emerald-700" : m.action === "rejected" ? "text-red-700" : "text-gray-800")}>{ACTION_TEXT[m.action] ?? m.action}</td>
                      <td className="border border-[#BFDEDB] px-2 py-1.5">{personLabel(m.from_user)}<span className="block text-[11px] text-gray-500">{m.from_stage_title}</span></td>
                      <td className="border border-[#BFDEDB] px-2 py-1.5">{m.to_user ? personLabel(m.to_user) : "—"}{m.to_stage_title && <span className="block text-[11px] text-gray-500">{m.to_stage_title}</span>}</td>
                      <td className="border border-[#BFDEDB] px-2 py-1.5 whitespace-pre-wrap">{m.remark || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* In-charge: save, certify, send */}
      {editing && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-gray-900">Send for approval</h2>
              <p className="text-sm text-gray-500">Save your entries any time. When everything is ready, certify and send it to a DDO.</p>
            </div>
            <button onClick={handleSave} disabled={!dirty || !!busy}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold border border-[#0D6E6E] text-[#0D6E6E] hover:bg-[#E6F4F4] disabled:opacity-40">
              {busy === "save" ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {dirty ? "Save" : "Saved"}
            </button>
          </div>
          <label className="flex items-start gap-3 p-3 rounded-xl border border-gray-200 bg-[#F9FBFB] cursor-pointer">
            <input type="checkbox" checked={certified} onChange={(e) => setCertified(e.target.checked)} className="mt-1 w-4 h-4 accent-[#0D6E6E]" />
            <span className="text-sm text-gray-800">I certify that the data entered above has been checked and is correct, and that the amount required for each sub head is within the available fund.</span>
          </label>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3 items-end">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">Send to DDO</label>
              <SearchableSelect
                options={ddos.map((d) => ({ value: d.id, label: personLabel(d) }))}
                value={ddoId} onChange={setDdoId}
                placeholder={ddos.length ? "Choose a DDO…" : "No DDO has been set up yet"}
                searchPlaceholder="Search DDOs…" disabled={!ddos.length}
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">Remark <span className="font-normal text-gray-400">(optional)</span></label>
              <input value={sendRemark} onChange={(e) => setSendRemark(e.target.value)} maxLength={4000}
                className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]" />
            </div>
            <button onClick={handleProceed} disabled={!!busy || !certified || !ddoId}
              className="flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold bg-[#0D6E6E] text-white hover:bg-[#178F8F] disabled:opacity-50">
              {busy === "submit" ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} Proceed
            </button>
          </div>
        </div>
      )}

      {/* Officer holding it: approve / return / forward */}
      {sheet.can_act && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 space-y-3">
          <h2 className="text-base font-bold text-gray-900">Your action as {sheet.stage_title}</h2>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1.5">Remark <span className="font-normal text-gray-400">(required when returning)</span></label>
            <textarea value={officerRemark} onChange={(e) => setOfficerRemark(e.target.value)} rows={3} maxLength={4000}
              className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]" />
          </div>
          <div className="flex flex-wrap gap-2 justify-end">
            <button onClick={() => officerAction("reject")} disabled={act.isPending}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50">
              <RotateCcw size={15} /> Return to In-charge
            </button>
            {sheet.can_forward && (
              <button onClick={() => officerAction("forward")} disabled={act.isPending}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold border border-[#0D6E6E] text-[#0D6E6E] hover:bg-[#E6F4F4] disabled:opacity-50">
                <ArrowRight size={15} /> Forward to {sheet.forward_to_title}
              </button>
            )}
            <button onClick={() => officerAction("approve")} disabled={act.isPending}
              className="flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
              {act.isPending ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} Approve
            </button>
          </div>
        </div>
      )}

      {!editing && !sheet.can_act && sheet.lines.some((l) => l.document) && (
        <p className="text-xs text-gray-400 flex items-center gap-1.5"><FileText size={12} /> Click a document name to open it.</p>
      )}
    </div>
  );
}
