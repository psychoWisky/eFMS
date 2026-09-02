"use client";
import { ChevronLeft, ChevronRight } from "lucide-react";

// Shared 15-rows-per-page pagination for every eFMS data table (Docket,
// My Files, Search results, Tracking History, …). `paginate` is a pure
// helper — slice the already-filtered/sorted rows with it, render
// `pageRows`, and drop <TablePagination> under the table.
export const TABLE_PAGE_SIZE = 15;

export function paginate<T>(rows: T[], page: number) {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / TABLE_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * TABLE_PAGE_SIZE;
  const pageRows = rows.slice(start, start + TABLE_PAGE_SIZE);
  return { pageRows, total, totalPages, page: safePage, start };
}

export function TablePagination({
  page,
  totalPages,
  total,
  start,
  pageCount,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  start: number;
  pageCount: number;
  onPage: (p: number) => void;
}) {
  if (totalPages <= 1) return null;
  const btn = "flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed";
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3 border-t border-gray-100">
      <span className="text-sm text-gray-500">
        {start + 1}–{start + pageCount} of {total}
      </span>
      <div className="flex items-center gap-2">
        <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft size={15} /> Prev
        </button>
        <span className="text-sm text-gray-500 px-1">Page {page} / {totalPages}</span>
        <button type="button" className={btn} disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
          Next <ChevronRight size={15} />
        </button>
      </div>
    </div>
  );
}
