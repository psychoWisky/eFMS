import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(
  date: string | Date,
  format: "short" | "long" | "relative" = "short"
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

  return d.toLocaleDateString("en-IN", { ...IST, day: "2-digit", month: "short", year: "numeric" });
}

export function truncate(str: string, len = 60): string {
  return str.length > len ? str.slice(0, len) + "…" : str;
}

export function getInitials(name: string): string {
  return name.split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

export function fileStatusBadgeClass(status: string): string {
  const map: Record<string, string> = {
    draft: "badge-draft",
    pending: "badge-pending",
    under_review: "badge-pending",
    approved: "badge-approved",
    rejected: "badge-rejected",
    dispatched: "badge-approved",
    archived: "badge-draft",
    locked: "badge-locked",
  };
  return map[status] ?? "badge-draft";
}

export function fileStatusLabel(status: string): string {
  const map: Record<string, string> = {
    draft: "Draft",
    pending: "Pending",
    under_review: "Under Review",
    approved: "Approved",
    rejected: "Rejected",
    dispatched: "Dispatched",
    archived: "Archived",
    locked: "Locked",
  };
  return map[status] ?? status;
}
