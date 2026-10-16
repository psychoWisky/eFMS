// FOC (Fixation of Ceiling) — shared types and helpers for the /foc module.
// Mirrors backend app/api/v1/endpoints/foc.py.
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";

export type FocStatus = "draft" | "pending" | "approved" | "rejected";
export type FocRole = "ddo" | "assistant_comptroller" | "finance_officer" | "vice_chancellor";

export const FOC_ROLE_TITLES: Record<FocRole, string> = {
  ddo: "DDO",
  assistant_comptroller: "Assistant Comptroller",
  finance_officer: "Finance Officer",
  vice_chancellor: "Vice Chancellor",
};

export interface FocPerson { id: string; full_name: string; designation: string | null; email: string; }

export interface FocMe {
  is_super_admin: boolean;
  is_incharge: boolean;
  officer_roles: FocRole[];
  officer_titles: string[];
  has_access: boolean;
}

export interface FocProject {
  id: string; name: string; funded_by: string | null; funding_agency: string | null;
  establishment_id: string | null; establishment_name: string | null;
  department_id: string | null; department_name: string | null;
  pi_name: string | null; project_type: string | null;
  bank_account_holder: string | null; bank_name: string | null; bank_account_no: string | null;
  fund_instrument_no: string | null; fund_received_date: string | null; fund_sanction_remittance_no: string | null;
  is_active: boolean;
}

export interface FocLine {
  id: string; sl_no: number; sub_head: string;
  sanctioned_fund: string; available_fund: string; amount_required: string;
  sanction_order_no: string | null; purpose: string | null; remark: string | null;
  document: { name: string; size: number | null; mime: string | null; url: string } | null;
}

export interface FocMovement {
  action: "submitted" | "forwarded" | "approved" | "rejected";
  remark: string | null;
  from_user: FocPerson | null; from_stage: string | null; from_stage_title: string;
  to_user: FocPerson | null; to_stage: string | null; to_stage_title: string | null;
  created_at: string | null;
}

export interface FocSheet {
  id: string; number: number; name: string; financial_year: string;
  status: FocStatus; status_label: string; stage: FocRole | null; stage_title: string | null;
  project: FocProject; incharge: FocPerson | null; holder: FocPerson | null;
  certified: boolean; created_at: string | null; submitted_at: string | null;
  decided_stage: FocRole | null; decided_stage_title: string | null; decided_at: string | null;
  lines: FocLine[]; total_required: string; total_required_words: string;
  movements: FocMovement[];
  can_edit: boolean; can_submit: boolean; can_act: boolean; can_forward: boolean;
  forward_to_title: string | null; can_download: boolean;
}

export interface FocSummary {
  id: string; number: number; name: string; financial_year: string;
  project_name: string | null; establishment_name: string | null; department_name: string | null;
  incharge: FocPerson | null; status: FocStatus; status_label: string;
  stage: FocRole | null; stage_title: string | null; holder: FocPerson | null;
  total_required: string; submitted_at: string | null; updated_at: string | null;
  dispatched_by: FocPerson | null; dispatched_at: string | null;
  box: "to_process" | "approved" | "returned" | null;
  my_last_action?: string | null; my_last_action_at?: string | null;
}

export function useFocMe(enabled = true) {
  return useQuery<FocMe>({
    queryKey: ["foc-me"],
    queryFn: () => api.get("/foc/me").then((r) => r.data),
    staleTime: 60_000,
    retry: false,
    enabled,
  });
}

/** 1513842.5 → "15,13,842.50" (Indian grouping). */
export function formatINR(value: string | number | null | undefined): string {
  const n = typeof value === "number" ? value : parseFloat(value ?? "0");
  if (!Number.isFinite(n)) return "0.00";
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatFocDate(iso: string | null | undefined, withTime = true): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
    timeZone: "Asia/Kolkata",
  });
}

export function personLabel(p: FocPerson | null | undefined): string {
  if (!p) return "—";
  return p.designation ? `${p.full_name} (${p.designation})` : p.full_name;
}

export const STATUS_BADGE: Record<FocStatus, string> = {
  draft: "bg-gray-100 text-gray-700 border-gray-200",
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
};

export function apiDetail(err: unknown, fallback: string): string {
  const d = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  return typeof d === "string" ? d : fallback;
}

/** Fetches an authenticated file and opens / saves it. */
export async function openFocBlob(url: string, filename: string, download: boolean): Promise<void> {
  // The API client already prefixes /api/v1.
  const path = url.replace(/^\/api\/v1/, "");
  let r;
  try {
    r = await api.get(path, { responseType: "blob" });
  } catch (err) {
    // With responseType "blob" the server's JSON error arrives as a Blob too.
    const data = (err as { response?: { data?: unknown } })?.response?.data;
    let message = "Could not open the file.";
    if (data instanceof Blob) {
      try { message = (JSON.parse(await data.text()) as { detail?: string }).detail ?? message; } catch { /* not JSON */ }
    }
    throw new Error(message);
  }
  const href = URL.createObjectURL(r.data as Blob);
  if (download) {
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } else {
    window.open(href, "_blank", "noopener");
  }
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}
