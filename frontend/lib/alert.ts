"use client";
// Single source of truth for confirmation dialogs and success messages across
// eFMS — every screen that needs a "are you sure?" confirm or a "done!"
// success message should import confirmAction()/showSuccess() from here
// instead of building another modal or calling SweetAlert directly. Backend
// validation errors and inline form-validation messages continue to use the
// existing `sonner` toast (toast.error) — this file only replaces
// confirmation dialogs and success notifications, per the project convention.
import Swal from "sweetalert2";

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

/** Show a brief, non-blocking-feeling success confirmation (auto-dismisses). */
export function showSuccess(title: string, text?: string): void {
  Swal.fire({
    title,
    text,
    icon: "success",
    confirmButtonColor: BRAND_COLOR,
    timer: 2200,
    timerProgressBar: true,
    showConfirmButton: false,
  });
}
