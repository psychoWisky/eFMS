"use client";
// File Tracking History: a dedicated module, separate from My Files / My
// Docket / Track Status. One row per file the user has ever participated in
// (created, received, or forwarded) — see GET /tracking/history.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { cn, formatDate, matchesRefSuffix, resolveDateRange, fileStatusBadgeClass, fileStatusLabel, type DateRangePreset } from "@/lib/utils";
import { PersonBadge, type PersonInfo } from "@/components/shared/person-badge";
import { Search, Eye, Loader2, History } from "lucide-react";
import { TimelineModal } from "./timeline-modal";

interface TrackingItem {
  file_id: string; ref_number: string; subject: string; status: string;
  current_holder_info: PersonInfo | null;
  from_user_info: PersonInfo | null;
  to_user_info: PersonInfo | null;
  forwarded_at: string | null;
  updated_at: string;
  created_at: string;
}

const RANGE_OPTIONS: { id: DateRangePreset; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "This Week" },
  { id: "month", label: "This Month" },
  { id: "3months", label: "Last 3 Months" },
  { id: "6months", label: "Last 6 Months" },
];

export function FileTrackingHistoryPage() {
  const [rangeId, setRangeId] = useState<DateRangePreset | "custom" | "all">("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [search, setSearch] = useState("");
  const [timelineFileId, setTimelineFileId] = useState<string | null>(null);

  const bounds = rangeId === "all" ? { from: "", to: "" }
    : rangeId === "custom" ? { from: customFrom, to: customTo }
    : resolveDateRange(rangeId);

  const { data: items = [], isLoading } = useQuery<TrackingItem[]>({
    queryKey: ["tracking-history", bounds.from, bounds.to],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (bounds.from) params.set("from", bounds.from);
      if (bounds.to) params.set("to", bounds.to);
      return (await api.get(`/tracking/history?${params.toString()}`)).data;
    },
  });

  // Ref-number search stays entirely client-side, reusing the one shared
  // matchesRefSuffix() implementation — no second matching algorithm.
  const filtered = items.filter((f) => matchesRefSuffix(f.ref_number, search));

  return (
    <div className="min-h-screen bg-[#F5F7FA]">
      <div className="bg-white border-b border-gray-200 px-8 py-5">
        <h1 className="text-2xl font-bold text-[#1A1A2E] flex items-center gap-2"><History size={22} className="text-[#0D6E6E]" /> File Tracking History</h1>
        <p className="text-base text-[#4A5568] mt-0.5">Every file you have ever created, received, or forwarded.</p>
      </div>

      <div className="px-8 py-6 space-y-4">
        {/* Date-range filters */}
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setRangeId("all")}
            className={cn("px-3 py-2 rounded-xl text-sm font-semibold border-2 transition-colors",
              rangeId === "all" ? "border-[#0D6E6E] bg-[#0D6E6E] text-white" : "border-gray-200 text-gray-600 hover:border-[#0D6E6E] hover:text-[#0D6E6E]")}>
            All Time
          </button>
          {RANGE_OPTIONS.map((r) => (
            <button key={r.id} onClick={() => setRangeId(r.id)}
              className={cn("px-3 py-2 rounded-xl text-sm font-semibold border-2 transition-colors",
                rangeId === r.id ? "border-[#0D6E6E] bg-[#0D6E6E] text-white" : "border-gray-200 text-gray-600 hover:border-[#0D6E6E] hover:text-[#0D6E6E]")}>
              {r.label}
            </button>
          ))}
          <button onClick={() => setRangeId("custom")}
            className={cn("px-3 py-2 rounded-xl text-sm font-semibold border-2 transition-colors",
              rangeId === "custom" ? "border-[#0D6E6E] bg-[#0D6E6E] text-white" : "border-gray-200 text-gray-600 hover:border-[#0D6E6E] hover:text-[#0D6E6E]")}>
            Custom Date Range
          </button>
        </div>

        {rangeId === "custom" && (
          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-sm text-gray-600">From <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="ml-1 border border-gray-300 rounded-lg px-2 py-1.5 text-sm" /></label>
            <label className="text-sm text-gray-600">To <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="ml-1 border border-gray-300 rounded-lg px-2 py-1.5 text-sm" /></label>
          </div>
        )}

        {/* Ref number search */}
        <div className="relative max-w-xs">
          <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by file number…"
            className="w-full border border-gray-300 rounded-xl pl-10 pr-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]" />
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16 gap-3 text-gray-400"><Loader2 size={22} className="animate-spin" /> Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
            <History size={40} className="mx-auto mb-3 text-gray-200" />
            <p className="text-lg font-semibold text-gray-600">{items.length === 0 ? "No files found for this range." : "No files match your search."}</p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {["File Number", "Subject", "Status", "Current Holder", "From", "To", "Forwarded", "Last Action", "Action"].map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-sm font-semibold text-gray-600 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((f) => (
                  <tr key={f.file_id} className="hover:bg-gray-50">
                    <td className="px-4 py-3"><span className="font-mono text-xs font-bold text-[#0D6E6E] bg-[#E6F4F4] px-2 py-1 rounded whitespace-nowrap">{f.ref_number}</span></td>
                    <td className="px-4 py-3 max-w-[220px]"><p className="text-sm font-medium text-gray-900 truncate">{f.subject}</p></td>
                    <td className="px-4 py-3"><span className={cn("badge text-xs", fileStatusBadgeClass(f.status))}>{fileStatusLabel(f.status)}</span></td>
                    <td className="px-4 py-3"><PersonBadge person={f.current_holder_info} compact /></td>
                    <td className="px-4 py-3"><PersonBadge person={f.from_user_info} compact /></td>
                    <td className="px-4 py-3"><PersonBadge person={f.to_user_info} compact /></td>
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{f.forwarded_at ? formatDate(f.forwarded_at, "datetime") : "—"}</td>
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{formatDate(f.updated_at, "datetime")}</td>
                    <td className="px-4 py-3">
                      <button onClick={() => setTimelineFileId(f.file_id)}
                        className="flex items-center gap-1 px-3 py-1.5 bg-[#0D6E6E] text-white rounded-lg text-xs font-medium hover:bg-[#178F8F] whitespace-nowrap">
                        <Eye size={13} /> View Timeline
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {timelineFileId && (
        <TimelineModal fileId={timelineFileId} onClose={() => setTimelineFileId(null)} />
      )}
    </div>
  );
}
