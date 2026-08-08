import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(
  date: string | Date,
  format: "short" | "long" | "relative" | "datetime" = "short"
): string {
  const d = new Date(date);
  if (isNaN(d.getTime())) return "—";

  if (format === "relative") {
    const diff = Date.now() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
  }

  const IST = { timeZone: "Asia/Kolkata" } as const;

  if (format === "long") {
    return d.toLocaleString("en-IN", { ...IST, day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  if (format === "datetime") {
    return d.toLocaleString("en-IN", { ...IST, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  return d.toLocaleDateString("en-IN", { ...IST, day: "2-digit", month: "short", year: "numeric" });
}

export function truncate(str: string, len = 60): string {
  return str.length > len ? str.slice(0, len) + "…" : str;
}

export function getInitials(name: string): string {
  return name.split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

const PREVIEWABLE_MIME_TYPES = new Set([
  "application/pdf",
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml",
  "text/plain",
]);
const NATIVE_PREVIEW_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "gif", "webp", "svg", "txt"];
const SHEET_PREVIEW_EXTENSIONS = ["xls", "xlsx", "csv"];

export type AttachmentPreviewKind = "native" | "docx" | "doc" | "sheet" | "none";

/**
 * Classifies how an attachment should be previewed. "native" = the browser's
 * own PDF/image viewer (unchanged, opened directly via the /view endpoint).
 * "docx"/"doc" = the shared DocxViewer (doc goes through the on-the-fly
 * preview-docx conversion first). "sheet" = client-side HTML table render
 * (xls/xlsx/csv). "none" = no preview available — show the fallback message.
 * Single source of truth reused by the attachment list, the Attachment
 * Preview modal, and the File Tracking History timeline, so they can never
 * classify the same file differently.
 */
export function getAttachmentPreviewKind(att: { mime_type: string | null; original_name: string }): AttachmentPreviewKind {
  const ext = att.original_name.split(".").pop()?.toLowerCase() ?? "";
  if ((att.mime_type && PREVIEWABLE_MIME_TYPES.has(att.mime_type)) || NATIVE_PREVIEW_EXTENSIONS.includes(ext)) return "native";
  if (att.mime_type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || ext === "docx") return "docx";
  if (att.mime_type === "application/msword" || ext === "doc") return "doc";
  if (SHEET_PREVIEW_EXTENSIONS.includes(ext)) return "sheet";
  return "none";
}

/** Shared by the attachment panel and the File Tracking History timeline. */
export function isPreviewable(att: { mime_type: string | null; original_name: string }): boolean {
  return getAttachmentPreviewKind(att) !== "none";
}

export function fileStatusBadgeClass(status: string): string {
  const map: Record<string, string> = {
    draft: "badge-draft",
    active: "badge-active",
    released: "badge-released",
    dispatched: "badge-active",
  };
  return map[status] ?? "badge-draft";
}

export function fileStatusLabel(status: string): string {
  const map: Record<string, string> = {
    draft: "Draft",
    active: "Active",
    released: "Released",
    dispatched: "Dispatched",
  };
  return map[status] ?? status;
}

/**
 * Matches a file's ref number against a search query using ONLY the final
 * numeric segment (e.g. "AVFU/AGRO/2026/GEN/0003" -> "0003"), leading-zero
 * insensitive: "3", "03", "003", and "0003" all match. Shared by Docket,
 * My Files, and the Reopen picker so this rule lives in exactly one place.
 */
export function matchesRefSuffix(refNumber: string, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const lastSegment = refNumber.split("/").pop() ?? "";
  const normalize = (s: string) => s.replace(/^0+/, "") || "0";
  return normalize(lastSegment) === normalize(q);
}

export type DateRangePreset = "today" | "week" | "month" | "3months" | "6months";

/**
 * Resolves a date-range preset to concrete from/to bounds (YYYY-MM-DD), sent
 * straight through to the backend's existing from/to query params — the same
 * pattern search_files already accepts. Kept as the single place this preset
 * -> bounds mapping is computed, reused by File Tracking History (and any
 * future screen needing the same "Today / This Week / ..." presets).
 */
export function resolveDateRange(preset: DateRangePreset): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now);
  if (preset === "today") {
    // from === to
  } else if (preset === "week") {
    from.setDate(from.getDate() - 7);
  } else if (preset === "month") {
    from.setMonth(from.getMonth() - 1);
  } else if (preset === "3months") {
    from.setMonth(from.getMonth() - 3);
  } else if (preset === "6months") {
    from.setMonth(from.getMonth() - 6);
  }
  return { from: from.toISOString().slice(0, 10), to };
}
