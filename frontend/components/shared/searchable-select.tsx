"use client";
// Reusable Select2-style searchable dropdown. No search library exists in
// this project yet — every other dropdown is a plain native <select> — so
// this is the one shared implementation any screen needing a searchable
// picker (Office/Section/Person, Favorite Recipients, etc.) should reuse
// instead of hand-rolling another one.
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Search, X, Star } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SearchableSelectOption {
  value: string;
  label: string;
}

export interface SearchableSelectGroup {
  label: string;
  options: SearchableSelectOption[];
}

interface SearchableSelectProps {
  /** Flat option list — ignored if `groups` is also provided. */
  options?: SearchableSelectOption[];
  /** Sectioned option list (e.g. "⭐ Favorite Recipients" / "All Recipients").
   * Each group's options are filtered independently by search, and empty
   * groups are hidden — search naturally spans every group at once. */
  groups?: SearchableSelectGroup[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  clearable?: boolean;
  className?: string;
  /** When provided alongside onToggleFavorite, a star toggle renders on
   * every option row. Both are optional so existing callers are unaffected. */
  isFavorite?: (value: string) => boolean;
  onToggleFavorite?: (value: string) => void;
  showFavoriteToggle?: boolean;
}

export function SearchableSelect({
  options, groups, value, onChange, placeholder = "Select…", searchPlaceholder = "Search…",
  emptyMessage = "No options found.", disabled = false, clearable = true, className,
  isFavorite, onToggleFavorite, showFavoriteToggle,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const effectiveGroups: SearchableSelectGroup[] = groups ?? [{ label: "", options: options ?? [] }];
  const allOptions = effectiveGroups.flatMap((g) => g.options);
  const selected = allOptions.find((o) => o.value === value) ?? null;

  const q = search.trim().toLowerCase();
  const filteredGroups = (q
    ? effectiveGroups.map((g) => ({ ...g, options: g.options.filter((o) => o.label.toLowerCase().includes(q)) }))
    : effectiveGroups
  ).filter((g) => g.options.length > 0);

  const canShowStar = showFavoriteToggle ?? !!(isFavorite && onToggleFavorite);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function select(v: string) {
    onChange(v);
    setOpen(false);
    setSearch("");
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "w-full flex items-center justify-between gap-2 border border-gray-300 rounded-xl px-4 py-3 text-base text-left",
          "focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]",
          disabled ? "bg-gray-50 text-gray-400 cursor-not-allowed" : "bg-white hover:border-gray-400",
        )}
      >
        <span className={cn("truncate", !selected && "text-gray-400")}>{selected ? selected.label : placeholder}</span>
        <div className="flex items-center gap-1 shrink-0">
          {clearable && selected && !disabled && (
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => { e.stopPropagation(); select(""); }}
              className="text-gray-400 hover:text-gray-600 p-0.5"
            >
              <X size={14} />
            </span>
          )}
          <ChevronDown size={16} className="text-gray-400" />
        </div>
      </button>

      {open && !disabled && (
        <div className="absolute z-20 mt-1.5 w-full bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden">
          <div className="p-2 border-b border-gray-100">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full border border-gray-200 rounded-lg pl-8 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]"
              />
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {filteredGroups.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4 px-3">{emptyMessage}</p>
            ) : (
              filteredGroups.map((g) => (
                <div key={g.label || "default"}>
                  {g.label && (
                    <p className="px-3 pt-2.5 pb-1 text-xs font-bold text-gray-400 uppercase tracking-wide">{g.label}</p>
                  )}
                  {g.options.map((o) => (
                    <div
                      key={o.value}
                      className={cn(
                        "flex items-center gap-1 hover:bg-gray-50",
                        o.value === value && "bg-[#E6F4F4]",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => select(o.value)}
                        className={cn(
                          "flex-1 min-w-0 text-left px-3 py-2 text-sm truncate",
                          o.value === value && "text-[#0D6E6E] font-semibold",
                        )}
                      >
                        {o.label}
                      </button>
                      {canShowStar && isFavorite && onToggleFavorite && (
                        <button
                          type="button"
                          title={isFavorite(o.value) ? "Remove from favorites" : "Add to favorites"}
                          onClick={(e) => { e.stopPropagation(); onToggleFavorite(o.value); }}
                          className={cn(
                            "shrink-0 p-1.5 mr-1 rounded-lg",
                            isFavorite(o.value) ? "text-amber-400 hover:text-amber-500" : "text-gray-300 hover:text-amber-400",
                          )}
                        >
                          <Star size={15} fill={isFavorite(o.value) ? "currentColor" : "none"} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
