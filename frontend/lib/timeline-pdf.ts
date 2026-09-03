// Client-side "Download PDF" for the File Timeline modal. Renders a
// self-contained document that mirrors the notesheet download's AVFU
// letterhead + teal/gold theme, rasterises it with html2canvas-pro
// (Tailwind v4's oklch() colours break the older html2canvas), and writes
// it to a downloaded .pdf via jsPDF — no print dialog, no backend.
import { jsPDF } from "jspdf";
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

const TIMELINE_STYLE = `
  .tl-doc * { box-sizing: border-box; }
  .tl-doc {
    font-family: Arial, "Helvetica Neue", Helvetica, "Liberation Sans", sans-serif;
    font-size: 13px; line-height: 1.6; color: #1A1A1A; background: #ffffff;
  }
  .tl-doc strong, .tl-doc b { font-weight: 700; }

  .tl-doc .letterhead { width: 100%; border-collapse: collapse; }
  .tl-doc .lh-logo-cell { width: 88px; vertical-align: middle; padding: 0; }
  .tl-doc .lh-logo { width: 84px; height: auto; display: block; }
  .tl-doc .lh-titles { vertical-align: middle; text-align: center; padding: 0 10px 0 2px; }
  .tl-doc .lh-name-as {
    font-family: "Noto Sans Bengali", "Nirmala UI", "Lohit Bengali", Arial, sans-serif;
    font-size: 18px; font-weight: 700; letter-spacing: 0; line-height: 1.45; color: #0A5757; margin: 0;
  }
  .tl-doc .lh-name-en { font-size: 15.5px; font-weight: 700; letter-spacing: 1px; line-height: 1.4; color: #0A5757; margin: 1px 0 0 0; }
  .tl-doc .lh-addr { font-size: 11px; font-weight: 700; letter-spacing: 0.8px; color: #4A4A4A; margin: 3px 0 0 0; }
  .tl-doc .lh-rule { border: none; border-top: 2.5px solid #0D6E6E; margin: 7px 0 0 0; }
  .tl-doc .lh-rule-thin { border: none; border-top: 0.75px solid #C6902B; margin: 2px 0 0 0; }

  .tl-doc .doc-title { text-align: center; font-size: 13px; font-weight: 700; letter-spacing: 3px; text-transform: uppercase; color: #0A5757; margin: 14px 0 2px 0; }
  .tl-doc .gen-meta { text-align: center; font-size: 10px; letter-spacing: 0.3px; color: #7C8A8A; margin-bottom: 14px; }

  .tl-doc .file-info {
    border: 1px solid #BFDEDB; border-left: 4px solid #0D6E6E; background: #EEF6F5;
    padding: 10px 14px; margin-bottom: 18px;
  }
  .tl-doc .file-info table { width: 100%; border-collapse: collapse; }
  .tl-doc .file-info td { vertical-align: top; padding: 3px 0; font-size: 12.5px; }
  .tl-doc .fi-label { width: 130px; white-space: nowrap; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase; font-size: 10px; color: #0A5757; }

  .tl-doc .tl-item {
    border: 1px solid #E2E8E7; border-left: 4px solid #9AA6A5; border-radius: 4px;
    padding: 9px 12px; margin: 0 0 10px 0; page-break-inside: avoid;
  }
  .tl-doc .tl-route    { border-left-color: #0D6E6E; }
  .tl-doc .tl-sign     { border-left-color: #0E8A63; }
  .tl-doc .tl-created  { border-left-color: #C6902B; }
  .tl-doc .tl-released { border-left-color: #16A34A; }

  .tl-doc .tl-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .tl-doc .tl-chip {
    display: inline-block; font-size: 9.5px; font-weight: 700; letter-spacing: 1px;
    text-transform: uppercase; color: #fff; background: #333; padding: 2px 9px; border-radius: 2px;
  }
  .tl-doc .tl-route .tl-chip    { background: #0D6E6E; }
  .tl-doc .tl-sign .tl-chip     { background: #0E8A63; }
  .tl-doc .tl-created .tl-chip  { background: #C6902B; }
  .tl-doc .tl-released .tl-chip { background: #16A34A; }
  .tl-doc .tl-time { font-size: 10px; color: #7C8A8A; white-space: nowrap; }

  .tl-doc .tl-people { margin-top: 6px; font-size: 12.5px; color: #4A4A4A; line-height: 1.5; }
  .tl-doc .tl-name { font-weight: 700; color: #1A1A1A; }
  .tl-doc .tl-role { color: #7C8A8A; }
  .tl-doc .tl-arrow { color: #BFDEDB; font-weight: 700; }
  .tl-doc .tl-muted { color: #9AA6A5; }

  .tl-doc .tl-content {
    margin-top: 8px; font-size: 12.5px; line-height: 1.6; color: #1A1A1A;
    background: #F4FAF9; border: 1px solid #BFDEDB; border-radius: 3px; padding: 8px 12px;
  }
  .tl-doc .tl-content p { margin: 0 0 6px 0; }
  .tl-doc .tl-content p:last-child { margin-bottom: 0; }
  .tl-doc .tl-content ul, .tl-doc .tl-content ol { margin: 4px 0 6px 0; padding-left: 22px; }
  .tl-doc .tl-content table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 11.5px; }
  .tl-doc .tl-content th, .tl-doc .tl-content td { border: 1px solid #BFDEDB; padding: 4px 6px; }
  .tl-doc .tl-content th { background: #EEF6F5; color: #0A5757; font-weight: 700; }

  .tl-doc .tl-withheld { margin-top: 6px; font-size: 11.5px; font-style: italic; color: #9AA6A5; }
  .tl-doc .tl-empty { color: #7C8A8A; font-style: italic; }

  .tl-doc .footer {
    border-top: 2px solid #0D6E6E; margin-top: 18px; padding-top: 7px;
    font-size: 9px; letter-spacing: 0.5px; color: #7C8A8A; text-align: center;
  }
`;

function buildBody(file: TimelinePdfFile, events: TimelinePdfEvent[], logoUrl: string): string {
  const generated = escapeHtml(formatDate(new Date(), "datetime"));
  const holder = file.current_holder_info
    ? escapeHtml(
        [file.current_holder_info.full_name,
         [file.current_holder_info.designation, file.current_holder_info.department_name].filter(Boolean).join(" · ")]
          .filter(Boolean).join(" — "))
    : "&mdash;";
  const statusLabel = escapeHtml(
    file.is_released ? "Released" : file.status.charAt(0).toUpperCase() + file.status.slice(1),
  );
  const rows = events.length
    ? events.map(eventBlock).join("")
    : `<p class="tl-empty">No timeline events recorded.</p>`;

  return `
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
  `;
}

/** Build the styled File Timeline document and download it as a real .pdf
 *  file (html2canvas-pro + jsPDF — no print dialog).
 *
 *  The document is rendered ON-SCREEN behind a full-viewport white cover
 *  ("Preparing your PDF…") rather than off-screen: html2canvas reliably
 *  captures a laid-out, visible node, whereas a `left:-99999px` node often
 *  rasterises blank. The cover is removed only after the PDF is produced. */
export async function downloadTimelinePdf(file: TimelinePdfFile, events: TimelinePdfEvent[]): Promise<void> {
  const logoUrl = `${window.location.origin}/avfu_letterhead_logo.png`;

  // Preload the crest so html2canvas captures it rather than a blank box.
  await new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = logoUrl;
  });

  const cover = document.createElement("div");
  cover.style.cssText =
    "position:fixed;inset:0;z-index:2147483000;background:#ffffff;overflow:auto;" +
    "display:flex;flex-direction:column;align-items:center;padding:24px 16px;";

  const notice = document.createElement("div");
  notice.textContent = "Preparing your PDF…";
  notice.style.cssText =
    "font:600 14px Arial,sans-serif;color:#0A5757;margin-bottom:16px;";
  cover.appendChild(notice);

  const doc = document.createElement("div");
  doc.className = "tl-doc";
  doc.style.cssText = "width:794px;max-width:100%;background:#ffffff;";
  doc.innerHTML = `<style>${TIMELINE_STYLE}</style>${buildBody(file, events, logoUrl)}`;
  cover.appendChild(doc);
  document.body.appendChild(cover);

  const filename = `${file.ref_number.replace(/\//g, "-")}-timeline.pdf`;
  try {
    // Give the browser a frame to lay the document out (and load fonts).
    if (document.fonts?.ready) { try { await document.fonts.ready; } catch { /* ignore */ } }
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    await new Promise<void>((r) => setTimeout(r, 60));

    const { default: html2canvas } = await import("html2canvas-pro");
    const canvas = await html2canvas(doc, {
      scale: 2,
      useCORS: true,
      backgroundColor: "#ffffff",
      logging: false,
      windowWidth: doc.scrollWidth,
      windowHeight: doc.scrollHeight,
    });

    const pdf = new jsPDF({ unit: "pt", format: "a4", orientation: "portrait" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 22;
    const usableW = pageW - margin * 2;
    const usableH = pageH - margin * 2;
    const pxToPt = usableW / canvas.width;          // canvas px -> PDF pt
    const sliceHpx = Math.max(1, Math.floor(usableH / pxToPt));

    let rendered = 0;
    let firstPage = true;
    while (rendered < canvas.height) {
      const hpx = Math.min(sliceHpx, canvas.height - rendered);
      const pageCanvas = document.createElement("canvas");
      pageCanvas.width = canvas.width;
      pageCanvas.height = hpx;
      const ctx = pageCanvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
        ctx.drawImage(canvas, 0, rendered, canvas.width, hpx, 0, 0, canvas.width, hpx);
      }
      const img = pageCanvas.toDataURL("image/jpeg", 0.95);
      if (!firstPage) pdf.addPage();
      pdf.addImage(img, "JPEG", margin, margin, usableW, hpx * pxToPt);
      firstPage = false;
      rendered += hpx;
    }

    const blob = pdf.output("blob");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } finally {
    cover.remove();
  }
}
