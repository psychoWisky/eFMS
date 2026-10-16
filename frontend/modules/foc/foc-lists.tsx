"use client";
// FOC Docket (what is waiting with me / has come back to me), My FOCs (the
// in-charge's sheets) and History (sheets I have acted on as an officer).
import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Inbox, Loader2, Search, ArrowRight, Eye, Pencil } from "lucide-react";
import { api } from "@/services/api";
import { cn } from "@/lib/utils";
import { STATUS_BADGE, formatFocDate, formatINR, personLabel, useFocMe, type FocSummary } from "@/lib/foc";

function StatusBadge({ row }: { row: FocSummary }) {
  return (
    <span className={cn("inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold border whitespace-nowrap", STATUS_BADGE[row.status])}>
      {row.status_label}
    </span>
  );
}

function useFiltered(rows: FocSummary[] | undefined, query: string) {
  return useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!rows) return [];
    if (!q) return rows;
    return rows.filter((r) =>
      [String(r.number), r.name, r.financial_year, r.project_name, r.establishment_name, r.department_name,
        r.dispatched_by?.full_name, r.incharge?.full_name, r.status_label]
        .some((v) => (v ?? "").toLowerCase().includes(q)));
  }, [rows, query]);
}

function PageTitle({ title, subtitle, query, setQuery }: { title: string; subtitle: string; query: string; setQuery: (v: string) => void }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 mb-4">
      <div>
        <h1 className="text-2xl font-bold text-[#1A1A2E]">{title}</h1>
        <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>
      </div>
      <label className="relative w-full sm:w-72">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search FOCs…"
          className="w-full border border-gray-300 rounded-xl pl-9 pr-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]" />
      </label>
    </div>
  );
}

function TableShell({ loading, empty, emptyText, children, head }: {
  loading: boolean; empty: boolean; emptyText: string; children: React.ReactNode; head: string[];
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#0D6E6E] text-white text-left">
              {head.map((h) => <th key={h} className="px-4 py-3 font-semibold text-xs uppercase tracking-wide whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">{children}</tbody>
        </table>
      </div>
      {loading && <div className="flex items-center justify-center gap-2 py-12 text-gray-400"><Loader2 size={18} className="animate-spin" /> Loading…</div>}
      {!loading && empty && (
        <div className="flex flex-col items-center py-14 text-gray-400">
          <Inbox size={34} className="mb-2 text-gray-300" />
          <p className="text-sm">{emptyText}</p>
        </div>
      )}
    </div>
  );
}

export function FocDocketPage() {
  const { data: me } = useFocMe();
  const [query, setQuery] = useState("");
  const { data, isLoading } = useQuery<FocSummary[]>({
    queryKey: ["foc-docket"],
    queryFn: () => api.get("/foc/docket").then((r) => r.data),
    refetchInterval: 60_000,
  });
  const rows = useFiltered(data, query);
  const isOfficer = !!me && me.officer_roles.length > 0;

  return (
    <div>
      <PageTitle title="FOC Docket"
        subtitle={isOfficer
          ? "FOCs waiting for your action, and FOCs of yours that have come back."
          : "Your FOCs that have been approved or returned to you."}
        query={query} setQuery={setQuery} />
      <TableShell loading={isLoading} empty={!isLoading && rows.length === 0}
        emptyText={query ? "No FOC matches your search." : "Nothing in your FOC Docket right now."}
        head={["ID", "FOC Name", "Establishment", "Department / Office", "Dispatched By", "Dispatched Date", "Status", "Process"]}>
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-[#F4FAF9]">
            <td className="px-4 py-3 font-mono font-semibold text-[#0A5757]">{r.number}</td>
            <td className="px-4 py-3">
              <p className="font-semibold text-gray-900">{r.name}</p>
              <p className="text-xs text-gray-500">{r.project_name} · FY {r.financial_year}</p>
            </td>
            <td className="px-4 py-3 text-gray-700">{r.establishment_name ?? "—"}</td>
            <td className="px-4 py-3 text-gray-700">{r.department_name ?? "—"}</td>
            <td className="px-4 py-3 text-gray-700">{personLabel(r.dispatched_by)}</td>
            <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{formatFocDate(r.dispatched_at)}</td>
            <td className="px-4 py-3"><StatusBadge row={r} /></td>
            <td className="px-4 py-3">
              <Link href={`/foc/sheets/${r.id}`}
                className={cn("inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap",
                  r.box === "to_process" ? "bg-[#0D6E6E] text-white hover:bg-[#178F8F]"
                    : r.box === "returned" ? "bg-red-600 text-white hover:bg-red-700"
                    : "border border-gray-300 text-gray-700 hover:bg-gray-50")}>
                {r.box === "to_process" ? <>Process <ArrowRight size={13} /></>
                  : r.box === "returned" ? <><Pencil size={13} /> Edit</> : <><Eye size={13} /> View</>}
              </Link>
            </td>
          </tr>
        ))}
      </TableShell>
    </div>
  );
}

export function MyFocsPage() {
  const [query, setQuery] = useState("");
  const { data, isLoading } = useQuery<FocSummary[]>({
    queryKey: ["foc-mine"],
    queryFn: () => api.get("/foc/sheets/mine").then((r) => r.data),
  });
  const rows = useFiltered(data, query);
  return (
    <div>
      <PageTitle title="My FOCs" subtitle="FOCs assigned to you as the in-charge. Fill in a draft or a returned FOC and send it to a DDO."
        query={query} setQuery={setQuery} />
      <TableShell loading={isLoading} empty={!isLoading && rows.length === 0}
        emptyText={query ? "No FOC matches your search." : "No FOC has been assigned to you yet."}
        head={["ID", "FOC Name", "Project", "Financial Year", "Amount Required (₹)", "Status", "Last Updated", ""]}>
        {rows.map((r) => {
          const editable = r.status === "draft" || r.status === "rejected";
          return (
            <tr key={r.id} className="hover:bg-[#F4FAF9]">
              <td className="px-4 py-3 font-mono font-semibold text-[#0A5757]">{r.number}</td>
              <td className="px-4 py-3 font-semibold text-gray-900">{r.name}</td>
              <td className="px-4 py-3 text-gray-700">{r.project_name}</td>
              <td className="px-4 py-3 text-gray-700">{r.financial_year}</td>
              <td className="px-4 py-3 text-right font-mono">{formatINR(r.total_required)}</td>
              <td className="px-4 py-3"><StatusBadge row={r} /></td>
              <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{formatFocDate(r.updated_at)}</td>
              <td className="px-4 py-3">
                <Link href={`/foc/sheets/${r.id}`}
                  className={cn("inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap",
                    editable ? "bg-[#0D6E6E] text-white hover:bg-[#178F8F]" : "border border-gray-300 text-gray-700 hover:bg-gray-50")}>
                  {editable ? <><Pencil size={13} /> Fill in</> : <><Eye size={13} /> View</>}
                </Link>
              </td>
            </tr>
          );
        })}
      </TableShell>
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = { submitted: "Sent", forwarded: "Forwarded", approved: "Approved", rejected: "Returned" };

export function FocHistoryPage() {
  const [query, setQuery] = useState("");
  const { data, isLoading } = useQuery<FocSummary[]>({
    queryKey: ["foc-history"],
    queryFn: () => api.get("/foc/history").then((r) => r.data),
  });
  const rows = useFiltered(data, query);
  return (
    <div>
      <PageTitle title="FOC History" subtitle="Every FOC you have forwarded, approved or returned." query={query} setQuery={setQuery} />
      <TableShell loading={isLoading} empty={!isLoading && rows.length === 0}
        emptyText={query ? "No FOC matches your search." : "You have not acted on any FOC yet."}
        head={["ID", "FOC Name", "Establishment", "Department / Office", "In-charge", "Your Action", "Current Status", ""]}>
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-[#F4FAF9]">
            <td className="px-4 py-3 font-mono font-semibold text-[#0A5757]">{r.number}</td>
            <td className="px-4 py-3">
              <p className="font-semibold text-gray-900">{r.name}</p>
              <p className="text-xs text-gray-500">{r.project_name} · FY {r.financial_year}</p>
            </td>
            <td className="px-4 py-3 text-gray-700">{r.establishment_name ?? "—"}</td>
            <td className="px-4 py-3 text-gray-700">{r.department_name ?? "—"}</td>
            <td className="px-4 py-3 text-gray-700">{personLabel(r.incharge)}</td>
            <td className="px-4 py-3 text-gray-700 whitespace-nowrap">
              {ACTION_LABEL[r.my_last_action ?? ""] ?? "—"}
              <span className="block text-xs text-gray-400">{formatFocDate(r.my_last_action_at)}</span>
            </td>
            <td className="px-4 py-3"><StatusBadge row={r} /></td>
            <td className="px-4 py-3">
              <Link href={`/foc/sheets/${r.id}`} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border border-gray-300 text-gray-700 hover:bg-gray-50">
                <Eye size={13} /> View
              </Link>
            </td>
          </tr>
        ))}
      </TableShell>
    </div>
  );
}
