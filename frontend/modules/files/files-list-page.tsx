"use client";
import { useState } from "react";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Search, Plus, FileText, AlertCircle, ChevronRight, Loader2 } from "lucide-react";
import { api } from "@/services/api";
import { cn, formatDate, fileStatusBadgeClass, fileStatusLabel } from "@/lib/utils";
import { EmptyState } from "@/components/feedback/empty-state";

interface EfmsFile {
  id: string;
  ref_number: string;
  subject: string;
  category: string;
  status: string;
  priority: string;
  created_by: string;
  current_holder_id: string | null;
  updated_at: string;
}

const STATUSES = ["All", "draft", "pending", "under_review", "approved", "rejected", "dispatched"];

export function FilesListPage() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");

  const { data: files = [], isLoading, isError } = useQuery<EfmsFile[]>({
    queryKey: ["efms-files"],
    queryFn: async () => {
      const res = await api.get("/efms/files");
      return res.data;
    },
  });

  const filtered = files.filter((f) => {
    const q = search.toLowerCase();
    const matchSearch = !search || f.ref_number.toLowerCase().includes(q) || f.subject.toLowerCase().includes(q);
    const matchStatus = statusFilter === "All" || f.status === statusFilter;
    return matchSearch && matchStatus;
  });

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="page-header -mx-6 -mt-6 mb-0">
        <div>
          <h1 className="text-[28px] font-bold text-[#1A1A2E]">All Files</h1>
          <p className="text-[15px] text-[#4A5568] mt-0.5">Browse and manage all registered files.</p>
        </div>
        <button onClick={() => router.push("/files/new")} className="btn btn-primary gap-2">
          <Plus size={18} /> New File
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[220px] max-w-[360px]">
          <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-[#9CA3AF]" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search files…" className="form-input pl-10 h-11" />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="form-input h-11 min-w-[140px]">
          {STATUSES.map((s) => <option key={s} value={s}>{s === "All" ? "All Statuses" : fileStatusLabel(s)}</option>)}
        </select>
        <span className="text-[14px] text-[#4A5568] ml-auto">
          {isLoading ? "Loading…" : `${filtered.length} file${filtered.length !== 1 ? "s" : ""}`}
        </span>
      </div>

      {/* Table */}
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="card p-0 overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 gap-3 text-[#4A5568]">
            <Loader2 size={20} className="animate-spin" /> Loading files…
          </div>
        ) : isError ? (
          <EmptyState icon={FileText} title="Failed to load files" description="Could not connect to the server. Please try again." className="m-6" />
        ) : filtered.length === 0 ? (
          <EmptyState icon={FileText} title="No files found" description={files.length === 0 ? "Create your first file using the button above." : "Try adjusting your search or filters."} className="m-6" />
        ) : (
          <div className="overflow-x-auto">
            <table className="enterprise-table">
              <thead>
                <tr>
                  <th>File Ref</th>
                  <th>Subject</th>
                  <th>Category</th>
                  <th>Status</th>
                  <th>Priority</th>
                  <th>Last Updated</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((file) => (
                  <tr key={file.id} className="cursor-pointer" onClick={() => router.push(`/files/${file.id}`)}>
                    <td>
                      <span className="font-mono text-[13px] text-[#4A5568] bg-[#F0F7F7] px-2 py-0.5 rounded whitespace-nowrap">{file.ref_number}</span>
                      {file.priority === "urgent" && (
                        <span className="ml-1.5 text-[11px] text-red-600 font-semibold flex items-center gap-0.5 mt-0.5">
                          <AlertCircle size={11} /> Urgent
                        </span>
                      )}
                    </td>
                    <td className="font-medium text-[#1A1A2E] max-w-[260px]">
                      <p className="truncate">{file.subject}</p>
                    </td>
                    <td><span className="text-[13px] text-[#4A5568] bg-[#F5F7FA] px-2 py-0.5 rounded-md">{file.category}</span></td>
                    <td><span className={cn("badge", fileStatusBadgeClass(file.status))}>{fileStatusLabel(file.status)}</span></td>
                    <td><span className="text-[13px] capitalize text-[#4A5568]">{file.priority}</span></td>
                    <td className="text-[#4A5568] whitespace-nowrap text-[14px]">{formatDate(file.updated_at, "relative")}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => router.push(`/files/${file.id}`)} className="btn btn-secondary btn-sm gap-1">
                        Open <ChevronRight size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </motion.div>
    </div>
  );
}
