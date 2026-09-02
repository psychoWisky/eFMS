// Client-side "Download PDF" for the File Timeline modal. Builds a
// self-contained HTML document that mirrors the notesheet download's AVFU
// letterhead + teal/gold theme, opens it in a new window and triggers the
// browser's print dialog (Save as PDF). No backend, no dependencies.
import { escapeHtml } from "@/lib/alert";
import { formatDate, hasRealNotesheetContent } from "@/lib/utils";
import { toSafeNotesheetHtml } from "@/lib/notesheet-html";
import type { PersonInfo } from "@/components/shared/person-badge";

export interface TimelinePdfEvent {
  type: "created" | "route" | "sign" | "released";
  label: string;
  person?: PersonInfo | null;
  fromPerson?: PersonInfo | null;
  toPerson?: PersonInfo | null;
  hasContent: boolean;
  content: string | null;
  created_at: string;
}

export interface TimelinePdfFile {
  ref_number: string;
  subject: string;
  status: string;
  is_released: boolean;
  current_holder_info: PersonInfo | null;
}

function personLine(p?: PersonInfo | null, fallback = "System"): string {
  if (!p) return `<span class="tl-muted">${escapeHtml(fallback)}</span>`;
  const meta = [p.designation, p.department_name].filter(Boolean).join(" · ");
  const name = p.is_active === false ? `${p.full_name} (Inactive)` : p.full_name;
  return (
    `<span class="tl-name">${escapeHtml(name)}</span>` +
    (meta ? `<span class="tl-role"> · ${escapeHtml(meta)}</span>` : "")
  );
}

function eventBlock(ev: TimelinePdfEvent): string {
  // `hasContent` means "a note exists but was withheld from this viewer".
  // A blank / never-written note produces neither a box nor a notice.
  const people =
    (ev.type === "route" || (ev.type === "created" && ev.toPerson))
      ? `${personLine(ev.fromPerson)}` +
        (ev.toPerson ? `<span class="tl-arrow"> &rarr; </span>${personLine(ev.toPerson)}` : "")
      : personLine(ev.person);

  let body = "";
  if (ev.content && hasRealNotesheetContent(ev.content)) {
    body = `<div class="tl-content">${toSafeNotesheetHtml(ev.content)}</div>`;
  } else if (ev.hasContent) {
    body = `<div class="tl-withheld">Content is not accessible to you.</div>`;
  }

  return `
    <div class="tl-item tl-${ev.type}">
      <div class="tl-head">
        <span class="tl-chip">${escapeHtml(ev.label)}</span>
        <span class="tl-time">${escapeHtml(formatDate(ev.created_at, "datetime"))} IST</span>
      </div>
      <div class="tl-people">${people}</div>
      ${body}
    </div>`;
}

function buildHtml(file: TimelinePdfFile, events: TimelinePdfEvent[], logoUrl: string): string {
  const generated = escapeHtml(formatDate(new Date(), "datetime"));
  const holder = file.current_holder_info
    ? escapeHtml(
        [file.current_holder_info.full_name,
         [file.current_holder_info.designation, file.current_holder_info.department_name].filter(Boolean).join(" · ")]
          .filter(Boolean).join(" — "))
    : "&mdash;";
  const statusLabel = escapeHtml(file.is_released ? "Released" : file.status.charAt(0).toUpperCase() + file.status.slice(1));

  const rows = events.length
    ? events.map(eventBlock).join("")
    : `<p class="tl-empty">No timeline events recorded.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>File Timeline &mdash; ${escapeHtml(file.ref_number)}</title>
<style>
  @page { size: A4; margin: 15px; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: Arial, "Helvetica Neue", Helvetica, "Liberation Sans", sans-serif;
    font-size: 13px; line-height: 1.6; color: #1A1A1A;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  strong, b { font-weight: 700; }

  /* ── letterhead (mirrors the notesheet download) ── */
  .letterhead { width: 100%; border-collapse: collapse; }
  .lh-logo-cell { width: 88px; vertical-align: middle; padding: 0; }
  .lh-logo { width: 84px; height: auto; display: block; }
  .lh-titles { vertical-align: middle; text-align: center; padding: 0 10px 0 2px; }
  .lh-name-as {
    font-family: "Noto Sans Bengali", "Nirmala UI", "Lohit Bengali", Arial, sans-serif;
    font-size: 18px; font-weight: 700; letter-spacing: 0; line-height: 1.45; color: #0A5757; margin: 0;
  }
  .lh-name-en { font-size: 15.5px; font-weight: 700; letter-spacing: 1px; line-height: 1.4; color: #0A5757; margin: 1px 0 0 0; }
  .lh-addr { font-size: 11px; font-weight: 700; letter-spacing: 0.8px; color: #4A4A4A; margin: 3px 0 0 0; }
  .lh-rule { border: none; border-top: 2.5px solid #0D6E6E; margin: 7px 0 0 0; }
  .lh-rule-thin { border: none; border-top: 0.75px solid #C6902B; margin: 2px 0 0 0; }

  .doc-title { text-align: center; font-size: 13px; font-weight: 700; letter-spacing: 3px; text-transform: uppercase; color: #0A5757; margin: 14px 0 2px 0; }
  .gen-meta { text-align: center; font-size: 10px; letter-spacing: 0.3px; color: #7C8A8A; margin-bottom: 14px; }

  /* ── file-info panel ── */
  .file-info {
    border: 1px solid #BFDEDB; border-left: 4px solid #0D6E6E; background: #EEF6F5;
    padding: 10px 14px; margin-bottom: 18px;
  }
  .file-info table { width: 100%; border-collapse: collapse; }
  .file-info td { vertical-align: top; padding: 3px 0; font-size: 12.5px; }
  .fi-label { width: 130px; white-space: nowrap; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase; font-size: 10px; color: #0A5757; }

  /* ── timeline ── */
  .timeline { }
  .tl-item {
    border: 1px solid #E2E8E7; border-left: 4px solid #9AA6A5; border-radius: 4px;
    padding: 9px 12px; margin: 0 0 10px 0; page-break-inside: avoid;
  }
  .tl-route    { border-left-color: #0D6E6E; }
  .tl-sign     { border-left-color: #0E8A63; }
  .tl-created  { border-left-color: #C6902B; }
  .tl-released { border-left-color: #16A34A; }

  .tl-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .tl-chip {
    display: inline-block; font-size: 9.5px; font-weight: 700; letter-spacing: 1px;
    text-transform: uppercase; color: #fff; background: #333; padding: 2px 9px; border-radius: 2px;
  }
  .tl-route .tl-chip    { background: #0D6E6E; }
  .tl-sign .tl-chip     { background: #0E8A63; }
  .tl-created .tl-chip   { background: #C6902B; }
  .tl-released .tl-chip { background: #16A34A; }
  .tl-time { font-size: 10px; color: #7C8A8A; white-space: nowrap; }

  .tl-people { margin-top: 6px; font-size: 12.5px; color: #4A4A4A; line-height: 1.5; }
  .tl-name { font-weight: 700; color: #1A1A1A; }
  .tl-role { color: #7C8A8A; }
  .tl-arrow { color: #BFDEDB; font-weight: 700; }
  .tl-muted { color: #9AA6A5; }

  .tl-content {
    margin-top: 8px; font-size: 12.5px; line-height: 1.6; color: #1A1A1A;
    background: #F4FAF9; border: 1px solid #BFDEDB; border-radius: 3px; padding: 8px 12px;
  }
  .tl-content p { margin: 0 0 6px 0; }
  .tl-content p:last-child { margin-bottom: 0; }
  .tl-content ul, .tl-content ol { margin: 4px 0 6px 0; padding-left: 22px; }
  .tl-content table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 11.5px; }
  .tl-content th, .tl-content td { border: 1px solid #BFDEDB; padding: 4px 6px; }
  .tl-content th { background: #EEF6F5; color: #0A5757; font-weight: 700; }

  .tl-withheld { margin-top: 6px; font-size: 11.5px; font-style: italic; color: #9AA6A5; }
  .tl-empty { color: #7C8A8A; font-style: italic; }

  .footer {
    border-top: 2px solid #0D6E6E; margin-top: 18px; padding-top: 7px;
    font-size: 9px; letter-spacing: 0.5px; color: #7C8A8A; text-align: center;
  }
</style>
</head>
<body>
  <table class="letterhead" cellpadding="0" cellspacing="0">
    <tr>
      <td class="lh-logo-cell"><img class="lh-logo" src="${logoUrl}" alt="AVFU"></td>
      <td class="lh-titles">
        <div class="lh-name-as">অসম পশু চিকিৎসা আৰু মীন বিশ্ববিদ্যালয়</div>
        <div class="lh-name-en">ASSAM VETERINARY AND FISHERY UNIVERSITY</div>
        <div class="lh-addr">KHANAPARA, GUWAHATI, ASSAM &#8211; 781022</div>
      </td>
    </tr>
  </table>
  <hr class="lh-rule">
  <hr class="lh-rule-thin">

  <div class="doc-title">File Timeline</div>
  <div class="gen-meta">Generated ${generated} IST</div>

  <div class="file-info">
    <table>
      <tr><td class="fi-label">File Number</td><td><strong>${escapeHtml(file.ref_number)}</strong></td></tr>
      <tr><td class="fi-label">Subject</td><td>${escapeHtml(file.subject)}</td></tr>
      <tr><td class="fi-label">Current Status</td><td>${statusLabel}</td></tr>
      <tr><td class="fi-label">Current Holder</td><td>${holder}</td></tr>
    </table>
  </div>

  <div class="timeline">${rows}</div>

  <div class="footer">Assam Veterinary and Fishery University &bull; eFMS &mdash; File Timeline</div>

  <script>
    window.onload = function () { setTimeout(function () { window.print(); }, 300); };
    window.onafterprint = function () { window.close(); };
  </script>
</body>
</html>`;
}

/** Open the styled File Timeline document in a new window and trigger the
 *  print dialog (the user picks "Save as PDF"). Returns false if a popup
 *  blocker prevented the window from opening. */
export function printTimelinePdf(file: TimelinePdfFile, events: TimelinePdfEvent[]): boolean {
  const logoUrl = `${window.location.origin}/avfu_letterhead_logo.png`;
  const html = buildHtml(file, events, logoUrl);
  const win = window.open("", "_blank", "width=900,height=800");
  if (!win) return false;
  win.document.open();
  win.document.write(html);
  win.document.close();
  return true;
}
