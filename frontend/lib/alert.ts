"use client";
// Single source of truth for confirmation dialogs and success messages across
// eFMS — every screen that needs a "are you sure?" confirm or a "done!"
// success message should import confirmAction()/showSuccess() from here
// instead of building another modal or calling SweetAlert directly. Backend
// validation errors and inline form-validation messages continue to use the
// existing `sonner` toast (toast.error) — this file only replaces
// confirmation dialogs and success notifications, per the project convention.
import Swal from "sweetalert2";
import { toast as sonnerToast } from "sonner";

const BRAND_COLOR = "#0D6E6E";
const DANGER_COLOR = "#DC2626";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface ConfirmOptions {
  title: string;
  /** Plain text body — safe by default. */
  text?: string;
  /** Pre-escaped/controlled HTML body, for cases needing multi-line or
   * emphasized content (e.g. a file reference number). Callers must escape
   * any user-supplied text themselves via escapeHtml() before interpolating. */
  html?: string;
  confirmText?: string;
  cancelText?: string;
  /** Red confirm button + warning styling, for destructive/irreversible actions. */
  danger?: boolean;
}

/** Show a confirmation dialog; resolves true if the user confirmed. */
export async function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  const result = await Swal.fire({
    title: opts.title,
    text: opts.html ? undefined : opts.text,
    html: opts.html,
    icon: opts.danger ? "warning" : "question",
    showCancelButton: true,
    confirmButtonText: opts.confirmText ?? "Yes, continue",
    cancelButtonText: opts.cancelText ?? "Cancel",
    confirmButtonColor: opts.danger ? DANGER_COLOR : BRAND_COLOR,
    cancelButtonColor: "#9CA3AF",
    reverseButtons: true,
    focusCancel: opts.danger,
  });
  return result.isConfirmed;
}

/** Show the generic "Unsaved Changes" leave-confirmation used by the
 * app-wide navigation guard (useUnsavedChangesGuard) whenever the user tries
 * to leave a dirty editing context through app-controlled navigation.
 * Deliberately has no "Save" option — saving only ever happens through the
 * explicit "Save Changes" button on the page itself, never as a side effect
 * of navigating away. Resolves true if the user chose to leave. */
export async function confirmLeaveUnsaved(): Promise<boolean> {
  const result = await Swal.fire({
    title: "Unsaved Changes",
    text: "You have unsaved changes. If you leave this page now, your changes will be lost.",
    icon: "warning",
    showCancelButton: true,
    confirmButtonText: "Leave",
    cancelButtonText: "Stay",
    confirmButtonColor: DANGER_COLOR,
    cancelButtonColor: BRAND_COLOR,
    reverseButtons: true,
    focusCancel: true,
  });
  return result.isConfirmed;
}

export type RenameDisplayChoice = "formerly" | "new_only";

/**
 * Asked when a role's name is changed: show the old name as
 * "New Name (formerly Old Name)", or show only the new name. Resolves null
 * if the Super Admin cancels (nothing is renamed).
 */
export async function askRenameDisplay(oldLabel: string, newLabel: string): Promise<RenameDisplayChoice | null> {
  const result = await Swal.fire({
    title: "Rename this role?",
    html:
      `<div style="text-align:left;font-size:15px;line-height:1.5">` +
      `<p style="margin:0 0 8px">“${escapeHtml(oldLabel)}” will become “${escapeHtml(newLabel)}”. ` +
      `Everyone holding it, and all its files and history, move to the new name.</p>` +
      `<p style="margin:0;font-weight:600">How should the old name be shown?</p></div>`,
    icon: "question",
    showDenyButton: true,
    showCancelButton: true,
    confirmButtonText: `Show “${escapeHtml(newLabel)} (formerly ${escapeHtml(oldLabel)})”`,
    denyButtonText: "Show the new name only",
    cancelButtonText: "Cancel",
    confirmButtonColor: BRAND_COLOR,
    denyButtonColor: "#4B5563",
    cancelButtonColor: "#9CA3AF",
    width: 560,
  });
  if (result.isConfirmed) return "formerly";
  if (result.isDenied) return "new_only";
  return null;
}

/** Pull the server's message out of a failed request, if it sent one. */
export function apiErrorDetail(err: unknown): string | null {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  return typeof detail === "string" && detail ? detail : null;
}

/**
 * "Can't do that" dialog for a refused delete. The server explains the exact
 * reasons as lines: the first is the headline, lines starting with "• " are
 * the reasons, and a trailing plain line is a hint. Shown as written (never
 * as HTML), so names and counts can't inject markup.
 */
export async function showBlocked(detail: string, title = "Cannot delete"): Promise<void> {
  const [headline, ...rest] = detail.split("\n");
  await Swal.fire({
    icon: "error",
    title,
    html:
      `<div style="text-align:left;font-size:15px;line-height:1.5">` +
      `<p style="margin:0 0 10px;font-weight:600">${escapeHtml(headline)}</p>` +
      rest
        .map((l) =>
          l.startsWith("• ")
            ? `<p style="margin:0 0 8px;padding-left:14px;text-indent:-14px">• ${escapeHtml(l.slice(2))}</p>`
            : `<p style="margin:10px 0 0;color:#4B5563">${escapeHtml(l)}</p>`,
        )
        .join("") +
      `</div>`,
    confirmButtonText: "OK",
    confirmButtonColor: BRAND_COLOR,
    width: 560,
  });
}

/**
 * Show a brief, non-blocking success notification in the top-right corner
 * (via Sonner) so it stays visible regardless of scroll position or open
 * modals. Auto-dismisses after 3.5 s.
 */
export function showSuccess(title: string, text?: string): void {
  const message = text ? `${title} — ${text}` : title;
  sonnerToast.success(message, {
    duration: 3500,
  });
}
