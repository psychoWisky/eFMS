"use client";
// Single source of truth for safely rendering stored notesheet/remark HTML —
// reused by Notesheet History (notesheet-editor.tsx) and Tracking History
// (timeline-modal.tsx) so there is exactly one render path, not one per
// screen. RouteEntry.remarks/Notesheet.content hold two eras of data in the
// same plain-text column: HTML from the Rich Text Editor (current) and
// legacy plain text from the pre-editor <textarea> (historical). Detect
// which one a given value is and normalize both to safe HTML for a single
// dangerouslySetInnerHTML render path.
import { escapeHtml } from "@/lib/alert";

const HTML_TAG_PATTERN = /<([a-z][a-z0-9]*)\b[^>]*>/i;

export function toSafeNotesheetHtml(raw: string): string {
  if (HTML_TAG_PATTERN.test(raw)) return raw; // Rich Text Editor output — already safe HTML, render as-is.
  return escapeHtml(raw).replace(/\r\n|\r|\n/g, "<br />"); // Legacy plain text — escape, then preserve line breaks.
}

// Compact prose styling for rendering stored notesheet/remark HTML inside a
// timeline/history entry (smaller than a page's primary notesheet document).
export const NOTESHEET_PROSE_CLASS = "prose prose-sm max-w-none leading-relaxed " +
  "[&_h1]:text-lg [&_h1]:font-bold [&_h1]:mt-2 [&_h1]:mb-1 " +
  "[&_h2]:text-base [&_h2]:font-bold [&_h2]:mt-2 [&_h2]:mb-1 " +
  "[&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-1.5 [&_h3]:mb-1 " +
  "[&_p]:mb-2 [&_ol]:pl-5 [&_ul]:pl-5 [&_li]:mb-0.5 [&_strong]:font-bold";
