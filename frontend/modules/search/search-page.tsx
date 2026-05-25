"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { cn, formatDate } from "@/lib/utils";
import { Search, Loader2, FileText, Eye, AlertCircle } from "lucide-react";

interface SearchResult {
  id: string; ref_number: string; subject: string; category: string;
  status: string; priority: string; created_at: string; updated_at: string;
}

const STATUS_COLOR: Record<string, string> = {
  draft:        "bg-gray-100 text-gray-600",
  pending:      "bg-amber-100 text-amber-700",
  under_review: "bg-blue-100 text-blue-700",
  approved:     "bg-green-100 text-green-700",
  rejected:     "bg-red-100 text-red-700",
  dispatched:   "bg-teal-100 text-teal-700",
};

const STATUSES = ["draft","pending","under_review","approved","rejected","dispatched"];
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

  const params = new URLSearchParams();
  if (keyword)  params.set("q", keyword);
  if (status)   params.set("status", status);
  if (category) params.set("category", category);
  if (fromDate) params.set("from_date", fromDate);
  if (toDate)   params.set("to_date", toDate);

  const { data: results = [], isFetching, refetch } = useQuery<SearchResult[]>({
    queryKey: ["file-search", keyword, status, category, fromDate, toDate],
    queryFn: async () => (await api.get(`/efms/files/search?${params.toString()}`)).data,
    enabled: false,
    staleTime: 0,
  });

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    refetch();
  }

  return (
    <div className="min-h-screen bg-[#F5F7FA]">
      <div className="bg-white border-b border-gray-200 px-8 py-5">
        <h1 className="text-2xl font-bold text-[#1A1A2E]">Search / Trace Files</h1>
        <p className="text-base text-[#4A5568] mt-0.5">Multi-parameter search across all files you are authorised to view.</p>
      </div>

      <div className="px-8 py-6 max-w-5xl">
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
              <select value={status} onChange={(e) => setStatus(e.target.value)} className={INPUT}>
                <option value="">All statuses</option>
                {STATUSES.map((s) => <option key={s} value={s}>{s.replace("_"," ")}</option>)}
              </select>
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
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    {["Ref Number","Subject","Category","Status","Priority","Created","Action"].map((h) => (
                      <th key={h} className="text-left px-5 py-3 text-sm font-semibold text-gray-600">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {results.map((f) => (
                    <tr key={f.id} className="hover:bg-gray-50">
                      <td className="px-5 py-3">
                        <span className="font-mono text-sm font-bold text-[#0D6E6E] bg-[#E6F4F4] px-2 py-0.5 rounded">{f.ref_number}</span>
                      </td>
                      <td className="px-5 py-3 max-w-xs">
                        <p className="text-sm font-semibold text-gray-900 truncate">{f.subject}</p>
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-600">{f.category}</td>
                      <td className="px-5 py-3">
                        <span className={cn("px-2 py-0.5 rounded-full text-xs font-semibold", STATUS_COLOR[f.status] ?? "bg-gray-100 text-gray-600")}>
                          {f.status.replace("_"," ")}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <span className={cn("px-2 py-0.5 rounded-full text-xs font-medium capitalize",
                          f.priority === "urgent" ? "bg-red-100 text-red-700 flex items-center gap-1" : "bg-gray-100 text-gray-600")}>
                          {f.priority === "urgent" && <AlertCircle size={11} className="inline" />} {f.priority}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-500">{formatDate(f.created_at)}</td>
                      <td className="px-5 py-3">
                        <button onClick={() => router.push(`/files/${f.id}`)}
                          className="flex items-center gap-1 px-3 py-1.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-medium hover:bg-[#178F8F]">
                          <Eye size={13} /> View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </div>
  );
}
