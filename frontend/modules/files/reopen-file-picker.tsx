"use client";
// New File -> "Use Existing Released File": lets the creator reopen one of
// their own released files. Reuses the same file record — no new file is
// created here; the backend flips is_released/status/current_holder_id only.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { toast } from "sonner";
import { showSuccess } from "@/lib/alert";
import { ChevronLeft, Search, Unlock, Loader2, FolderOpen } from "lucide-react";
import { formatDate, matchesRefSuffix } from "@/lib/utils";

interface MyReleasedFile {
  docket_id: string;
  file_id: string;
  ref_number: string;
  subject: string;
  category: string;
  released_at: string | null;
}

export function ReopenFilePicker({
  onBack,
  onReopened,
}: {
  onBack: () => void;
  onReopened: (fileId: string) => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");

  const { data: files = [], isLoading } = useQuery<MyReleasedFile[]>({
    queryKey: ["released-mine"],
    queryFn: async () => (await api.get("/docket/released/mine")).data,
  });

  const reopenMutation = useMutation({
    mutationFn: (fileId: string) => api.post(`/docket/${fileId}/reopen`, {}),
    onSuccess: (_res, fileId) => {
      qc.invalidateQueries({ queryKey: ["released-mine"] });
      qc.invalidateQueries({ queryKey: ["docket-released"] });
      qc.invalidateQueries({ queryKey: ["efms-files-outbox"] });
      qc.invalidateQueries({ queryKey: ["my-docket"] });
      showSuccess("File reopened.");
      onReopened(fileId);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(msg ?? "Could not reopen file.");
    },
  });

  const filtered = files.filter((f) => matchesRefSuffix(f.ref_number, search));

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-[#0D6E6E] hover:underline mb-4">
        <ChevronLeft size={14} /> Back
      </button>
      <h2 className="text-xl font-bold text-gray-900 mb-1">Use Existing Released File</h2>
      <p className="text-base text-gray-500 mb-5">Select one of your own released files to reopen and continue its workflow.</p>

      <div className="relative max-w-sm mb-4">
        <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by file number…"
          className="w-full border border-gray-300 rounded-xl pl-10 pr-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]"
        />
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 gap-3 text-gray-400">
          <Loader2 size={22} className="animate-spin" /> Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
          <FolderOpen size={40} className="mx-auto mb-3 text-gray-200" />
          <p className="text-lg font-semibold text-gray-600">
            {files.length === 0 ? "You have no released files yet." : "No files match your search."}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                {["Ref Number", "Subject", "Category", "Released On", "Action"].map((h) => (
                  <th key={h} className="text-left px-5 py-4 text-base font-semibold text-gray-600">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((f) => (
                <tr key={f.docket_id} className="hover:bg-gray-50">
                  <td className="px-5 py-4">
                    <span className="font-mono text-sm font-bold text-[#0D6E6E] bg-[#E6F4F4] px-2 py-1 rounded">{f.ref_number}</span>
                  </td>
                  <td className="px-5 py-4 max-w-xs">
                    <p className="text-base font-semibold text-gray-900 truncate">{f.subject}</p>
                  </td>
                  <td className="px-5 py-4 text-base text-gray-600">{f.category}</td>
                  <td className="px-5 py-4 text-base text-gray-500">{f.released_at ? formatDate(f.released_at, "relative") : "—"}</td>
                  <td className="px-5 py-4">
                    <button
                      onClick={() => reopenMutation.mutate(f.file_id)}
                      disabled={reopenMutation.isPending}
                      className="flex items-center gap-1 px-3 py-1.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-medium hover:bg-[#178F8F] disabled:opacity-50"
                    >
                      <Unlock size={14} /> Reopen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
