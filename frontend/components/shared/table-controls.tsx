"use client";
import { useMemo, useState } from "react";
import { ChevronUp, ChevronDown, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";

// Lightweight, opt-in table controls shared by every eFMS data table:
// free-text search across ALL columns + click-to-sort headers. Each table
// keeps its own markup and just wires these in:
//   const t = useTableSearchSort(rows, rowText, (r, k) => sortValue);
//   ... <TableSearchInput value={t.query} onChange={t.setQuery} />
//   ... <SortTh label="Subject" sortKey="subject" state={t} />
//   ... t.view.map(...)   // already searched + sorted (then paginate)

export type SortDir = "asc" | "desc";
export interface SortState { key: string; dir: SortDir }

export interface TableSearchSort<T> {
  query: string;
  setQuery: (q: string) => void;
  sort: SortState | null;
  toggleSort: (key: string) => void;
  view: T[];
}

/**
 * @param rows      the already-filtered source rows (e.g. after a status filter)
 * @param rowText   returns every searchable field of a row joined into one string
 * @param sortValue returns the comparable value for a given sort key (string | number | Date | null)
 * @param initial   optional initial sort
 */
export function useTableSearchSort<T>(
  rows: T[],
  rowText: (row: T) => string,
  sortValue: (row: T, key: string) => string | number | Date | null | undefined,
  initial?: SortState,
): TableSearchSort<T> {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState | null>(initial ?? null);

  const toggleSort = (key: string) =>
    setSort((s) =>
      s && s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );

  const searched = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => rowText(r).toLowerCase().includes(needle));
  }, [rows, query, rowText]);

  const view = useMemo(() => {
    if (!sort) return searched;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...searched].sort((a, b) => {
      let av = sortValue(a, sort.key);
      let bv = sortValue(b, sort.key);
      if (av instanceof Date) av = av.getTime();
      if (bv instanceof Date) bv = bv.getTime();
      const aNull = av === null || av === undefined || av === "";
      const bNull = bv === null || bv === undefined || bv === "";
      if (aNull && bNull) return 0;
      if (aNull) return 1;          // empty values always sink to the bottom
      if (bNull) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" }) * dir;
    });
  }, [searched, sort, sortValue]);

  return { query, setQuery, sort, toggleSort, view };
}

// ── Search input ────────────────────────────────────────────────────
export function TableSearchInput({
  value,
  onChange,
  placeholder = "Search all columns…",
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border border-gray-300 rounded-xl pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]"
      />
    </div>
  );
}

// ── Sortable <th> ───────────────────────────────────────────────────
export function SortTh({
  label,
  sortKey,
  state,
  className,
}: {
  label: React.ReactNode;
  sortKey: string;
  state: Pick<TableSearchSort<unknown>, "sort" | "toggleSort">;
  className?: string;
}) {
  const active = state.sort?.key === sortKey;
  return (
    <th
      onClick={() => state.toggleSort(sortKey)}
      className={cn(
        "text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-500 whitespace-nowrap select-none cursor-pointer hover:text-gray-700",
        className,
      )}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active
          ? (state.sort!.dir === "asc" ? <ChevronUp size={13} /> : <ChevronDown size={13} />)
          : <ChevronsUpDown size={13} className="opacity-30" />}
      </span>
    </th>
  );
}
