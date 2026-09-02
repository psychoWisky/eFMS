"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { cn, formatDate } from "@/lib/utils";
import { Search, Loader2, FileText, Eye } from "lucide-react";
import { FileClassificationBadge } from "@/components/shared/file-classification-badge";
import { PageHeader } from "@/components/shared/page-header";
import { SearchableSelect } from "@/components/shared/searchable-select";
import { paginate, TablePagination } from "@/components/shared/table-pagination";

interface SearchResult {
  id: string; ref_number: string; subject: string; category: string;
  status: string; priority: string; created_at: string; updated_at: string;
  is_released: boolean;
}

const STATUS_COLOR: Record<string, string> = {
  draft:    "bg-gray-100 text-gray-600",
  active:   "bg-amber-100 text-amber-700",
  released: "bg-green-100 text-green-700",
};

const STATUSES = ["draft", "active", "released"];
const INPUT = "w-full border border-gray-300 rounded-xl px-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]";
const LABEL = "block text-sm font-semibold text-gray-600 mb-1.5";

export function EFMSSearchPage() {
  const router = useRouter();
  const [keyword, setKeyword] = useState("");
  const [status, setStatus]   = useState("");
  const [category, setCategory] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate]     = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [page, setPage] = useState(1);

  const params = new URLSearchParams();
  if (keyword)  params.set("q", keyword);
  // "released" is a computed overlay (Docket.is_released), not a real status
  // column value — filter for it client-side instead of sending it to the API.
  if (status && status !== "released") params.set("status", status);
  if (category) params.set("category", category);
  if (fromDate) params.set("from_date", fromDate);
  if (toDate)   params.set("to_date", toDate);

  const { data: rawResults = [], isFetching, refetch } = useQuery<SearchResult[]>({
    queryKey: ["file-search", keyword, status, category, fromDate, toDate],
    queryFn: async () => (await api.get(`/efms/files/search?${params.toString()}`)).data,
    enabled: false,
    staleTime: 0,
  });

  const results = status === "released" ? rawResults.filter((r) => r.is_released) : rawResults;
  const { pageRows, total, totalPages, page: safePage, start } = paginate(results, page);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setPage(1);
    refetch();
  }

  return (
    <div className="min-h-screen bg-[#F5F7FA]">
      <PageHeader
        title="Search / Trace Files"
        subtitle="Multi-parameter search across all files you are authorised to view."
        icon={Search}
      />

      <div className="px-[15px] py-5">
        {/* Filters */}
        <form onSubmit={handleSearch} className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm mb-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
            <div className="lg:col-span-3">
              <label className={LABEL}>Keyword (subject or file number)</label>
              <div className="relative">
                <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                <input value={keyword} onChange={(e) => setKeyword(e.target.value)}
                  placeholder="Search by subject or ref number…"
                  className={`${INPUT} pl-11`} />
              </div>
            </div>
            <div>
              <label className={LABEL}>Status</label>
              <SearchableSelect
                options={STATUSES.map((s) => ({ value: s, label: s.replace("_", " ") }))}
                value={status}
                onChange={setStatus}
                placeholder="All statuses"
                searchPlaceholder="Search…"
              />
            </div>
            <div>
              <label className={LABEL}>Category</label>
              <input value={category} onChange={(e) => setCategory(e.target.value)}
                placeholder="e.g. Finance" className={INPUT} />
            </div>
            <div>
              <label className={LABEL}>Date From</label>
              <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className={INPUT} />
            </div>
            <div>
              <label className={LABEL}>Date To</label>
              <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className={INPUT} />
            </div>
          </div>
          <button type="submit" disabled={isFetching}
            className="flex items-center gap-2 px-6 py-2.5 bg-[#0D6E6E] text-white rounded-xl text-base font-semibold hover:bg-[#178F8F] disabled:opacity-50">
            {isFetching ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            {isFetching ? "Searching…" : "Search"}
          </button>
        </form>

        {/* Results */}
        {submitted && !isFetching && (
          results.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
              <FileText size={40} className="mx-auto mb-3 text-gray-200" />
              <p className="text-lg font-semibold text-gray-600">No files found</p>
              <p className="text-base text-gray-400 mt-1">Try different keywords or filters.</p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100">
                <p className="text-sm text-gray-500">{results.length} result{results.length !== 1 ? "s" : ""} found</p>
              </div>
              <div className="w-full overflow-x-auto">
              <table className="w-full min-w-[820px]">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    {["Ref Number","Subject","Category","Status","Priority","Created","Action"].map((h) => (
                      <th key={h} className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-500 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {pageRows.map((f) => {
                    const displayStatus = f.is_released ? "released" : f.status;
                    return (
                    <tr key={f.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <span className="font-mono text-sm font-bold text-[#0D6E6E] bg-[#E6F4F4] px-2 py-0.5 rounded">{f.ref_number}</span>
                      </td>
                      <td className="px-4 py-3 max-w-xs">
                        <p className="text-sm font-semibold text-gray-900 truncate">{f.subject}</p>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">{f.category}</td>
                      <td className="px-4 py-3">
                        <span className={cn("px-2 py-0.5 rounded-full text-xs font-semibold", STATUS_COLOR[displayStatus] ?? "bg-gray-100 text-gray-600")}>
                          {displayStatus}
                        </span>
                      </td>
                      <td className="px-4 py-3"><FileClassificationBadge priority={f.priority} compact /></td>
                      <td className="px-4 py-3 text-sm text-gray-500">{formatDate(f.created_at)}</td>
                      <td className="px-4 py-3">
                        <button onClick={() => router.push(`/files/${f.id}`)}
                          className="flex items-center gap-1 px-3 py-1.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-medium hover:bg-[#178F8F]">
                          <Eye size={13} /> View
                        </button>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
              <TablePagination page={safePage} totalPages={totalPages} total={total} start={start} pageCount={pageRows.length} onPage={setPage} />
            </div>
          )
        )}
      </div>
    </div>
  );
}
