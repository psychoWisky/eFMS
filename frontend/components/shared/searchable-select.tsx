"use client";
// Reusable Select2-style searchable dropdown. No search library exists in
// this project yet — every other dropdown is a plain native <select> — so
// this is the one shared implementation any screen needing a searchable
// picker (Office/Section/Person, Favorite Recipients, etc.) should reuse
// instead of hand-rolling another one.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Search, X, Star } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SearchableSelectOption {
  value: string;
  label: string;
  /** Optional structured search fields for callers that need "search by
   * name shows every match for that person, search by role narrows to
   * that role only" (the recipient pickers) instead of one flat
   * substring-on-label match. When absent, filtering falls back to the
   * plain label search every other SearchableSelect caller already uses
   * — this never changes existing behavior for Office/Section/admin
   * dropdowns etc. See buildGroups() in use-favorite-recipients.ts. */
  disabled?: boolean;
  searchName?: string;
  searchRole?: string;
}

export interface SearchableSelectGroup {
  label: string;
  options: SearchableSelectOption[];
}

// The open panel is rendered in a portal on document.body with fixed
// positioning, so a modal body or scrolling form can never clip it — the
// user never has to scroll the form to reach the options. It opens below
// the trigger when there's room, otherwise above, is sized to the visible
// viewport (including an open on-screen keyboard), and its option list has
// its own contained scroll.
const PANEL_GAP = 6;          // px between trigger and panel
const VIEWPORT_MARGIN = 8;    // px kept free at the viewport edges
const PANEL_MAX_HEIGHT = 380; // px, whole panel incl. search box
const SEARCH_BOX_HEIGHT = 57; // px, search header inside the panel
const PANEL_MIN_WIDTH = 260;  // px, so narrow fields (e.g. half-width on a phone) still get a readable list

interface PanelPos {
  top?: number;
  bottom?: number;
  left: number;
  width?: number;
  minWidth?: number;
  maxWidth: number;
  listMaxHeight: number;
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
  /** Let the open panel grow past the trigger width to fit long option
   * labels (e.g. recipient rows). Off by default so the panel stays inside
   * narrow containers like a modal column. */
  widePanel?: boolean;
}

export function SearchableSelect({
  options, groups, value, onChange, placeholder = "Select…", searchPlaceholder = "Search…",
  emptyMessage = "No options found.", disabled = false, clearable = true, className,
  isFavorite, onToggleFavorite, showFavoriteToggle, widePanel = false,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [pos, setPos] = useState<PanelPos | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const effectiveGroups: SearchableSelectGroup[] = groups ?? [{ label: "", options: options ?? [] }];
  const allOptions = effectiveGroups.flatMap((g) => g.options);
  const selected = allOptions.find((o) => o.value === value) ?? null;

  const q = search.trim().toLowerCase();
  // Structured match (searchName/searchRole present, e.g. recipient
  // pickers): searching a person's name matches every role-entry of
  // theirs (all share the same name); searching a role name narrows down
  // to entries actually stamped with that role, not every person whose
  // label happens to contain the text. Falls back to a plain label
  // substring match for every other SearchableSelect caller, unchanged.
  const matches = (o: SearchableSelectOption) =>
    o.searchName !== undefined || o.searchRole !== undefined
      ? (o.searchName?.toLowerCase().includes(q) ?? false) || (o.searchRole?.toLowerCase().includes(q) ?? false)
      : o.label.toLowerCase().includes(q);
  const filteredGroups = (q
    ? effectiveGroups.map((g) => ({ ...g, options: g.options.filter(matches) }))
    : effectiveGroups
  ).filter((g) => g.options.length > 0);

  const canShowStar = showFavoriteToggle ?? !!(isFavorite && onToggleFavorite);

  const close = useCallback(() => {
    setOpen(false);
    setSearch("");
    setPos(null);
  }, []);

  // Place the panel against the trigger, flipping above when there isn't
  // enough room below. Uses the visual viewport so an open mobile keyboard
  // is accounted for.
  const place = useCallback(() => {
    const t = triggerRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const vv = window.visualViewport;
    const vh = vv ? vv.height : window.innerHeight;
    const vw = vv ? vv.width : window.innerWidth;
    const below = vh - r.bottom - PANEL_GAP - VIEWPORT_MARGIN;
    const above = r.top - PANEL_GAP - VIEWPORT_MARGIN;
    const openUp = below < Math.min(PANEL_MAX_HEIGHT, 240) && above > below;
    const panelMax = Math.max(Math.min(PANEL_MAX_HEIGHT, openUp ? above : below), 120);
    const baseWidth = Math.max(r.width, PANEL_MIN_WIDTH);
    const maxWidth = Math.min(widePanel ? Math.max(640, baseWidth) : baseWidth, vw - VIEWPORT_MARGIN * 2);
    const width = Math.min(baseWidth, maxWidth);
    // Keep the whole panel on screen even when it is wider than its field.
    const left = Math.min(Math.max(r.left, VIEWPORT_MARGIN), vw - VIEWPORT_MARGIN - width);
    setPos({
      ...(openUp ? { bottom: vh - r.top + PANEL_GAP } : { top: r.bottom + PANEL_GAP }),
      left,
      ...(widePanel ? { minWidth: width } : { width }),
      maxWidth,
      listMaxHeight: panelMax - SEARCH_BOX_HEIGHT,
    });
  }, [widePanel]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    // Keep attached while anything scrolls (capture: modal bodies too) or
    // the viewport changes size (rotation, on-screen keyboard).
    const onMove = (e: Event) => {
      // Scrolling the option list itself doesn't move the trigger.
      if (e.type === "scroll" && panelRef.current?.contains(e.target as Node)) return;
      place();
    };
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    window.visualViewport?.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
      window.visualViewport?.removeEventListener("resize", onMove);
    };
  }, [open, place]);

  // Focus the search box without letting the browser scroll the page.
  useEffect(() => {
    if (open && pos) searchRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, !!pos]);

  useEffect(() => {
    if (!open) return;
    function onPointerDownOutside(e: PointerEvent) {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); close(); triggerRef.current?.focus(); }
    }
    document.addEventListener("pointerdown", onPointerDownOutside);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDownOutside);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, close]);

  function select(v: string) {
    onChange(v);
    close();
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
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

      {open && !disabled && pos && typeof document !== "undefined" && createPortal(
        // Portal + fixed position: above every modal (z-50/60), below
        // toasts. widePanel lets it grow to fit long labels (e.g.
        // "Name (code) · PI74 — Project Title"), never past the viewport.
        <div
          ref={panelRef}
          role="listbox"
          style={{
            position: "fixed",
            top: pos.top,
            bottom: pos.bottom,
            left: pos.left,
            width: pos.width,
            minWidth: pos.minWidth,
            maxWidth: pos.maxWidth,
          }}
          className={cn(
            "z-[80] bg-white border border-gray-200 rounded-xl shadow-xl overflow-hidden",
            widePanel && "w-max",
          )}
        >
          <div className="p-2 border-b border-gray-100">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full border border-gray-200 rounded-lg pl-8 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]"
              />
            </div>
          </div>
          {/* The list scrolls on its own; overscroll-contain stops the
              scroll from chaining to the form/page behind it. */}
          <div
            className="overflow-y-auto overscroll-contain touch-pan-y"
            style={{ maxHeight: pos.listMaxHeight, WebkitOverflowScrolling: "touch" }}
          >
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
                        "flex items-center gap-1",
                        o.disabled ? "opacity-50 cursor-not-allowed bg-gray-50/50" : "hover:bg-gray-50",
                        o.value === value && "bg-[#E6F4F4]",
                      )}
                    >
                      <button
                        type="button"
                        disabled={o.disabled}
                        onClick={() => !o.disabled && select(o.value)}
                        className={cn(
                          "flex-1 min-w-0 text-left px-3 py-2 text-sm whitespace-normal break-words",
                          o.disabled ? "text-gray-400 cursor-not-allowed" : (o.value === value ? "text-[#0D6E6E] font-semibold" : "text-gray-700"),
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
        </div>,
        document.body,
      )}
    </div>
  );
}
