"use client";
// Single source of truth for safely rendering stored notesheet/remark HTML —
// reused by Notesheet History (notesheet-editor.tsx) and Tracking History
// (timeline-modal.tsx) so there is exactly one render path, not one per
// screen. RouteEntry.remarks/Notesheet.content hold two eras of data in the
// same plain-text column: HTML from the Rich Text Editor (current) and
// legacy plain text from the pre-editor <textarea> (historical). Detect
// which one a given value is and normalize both to safe HTML for a single
// dangerouslySetInnerHTML render path.
import DOMPurify from "dompurify";
import { escapeHtml } from "@/lib/alert";

const HTML_TAG_PATTERN = /<([a-z][a-z0-9]*)\b[^>]*>/i;

// Mirrors the server's sanitiser (backend app/utils/html_sanitize.py): only
// what the editor itself produces. Pictures must be embedded (data:) — a
// remote picture would let a notesheet ping an outside server from every
// viewer's browser.
const ALLOWED_TAGS = [
  "p", "br", "div", "span", "strong", "b", "em", "i", "u", "s", "strike", "mark", "sub", "sup",
  "h1", "h2", "h3", "h4", "ul", "ol", "li", "blockquote", "pre", "code", "hr", "a", "img",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "colgroup", "col",
];
const ALLOWED_ATTR = [
  "style", "href", "target", "rel", "title", "src", "alt", "width", "height",
  "colspan", "rowspan", "colwidth", "data-colwidth", "data-color", "span", "start", "type",
];
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,/i;
const UNSAFE_CSS = /url\s*\(|expression|javascript|@import|\\|\/\*/i;

let hooked = false;
function ensureHooks() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
    if (data.attrName === "src" && node.nodeName === "IMG" && !DATA_IMAGE.test(data.attrValue)) data.keepAttr = false;
    if (data.attrName === "style" && UNSAFE_CSS.test(data.attrValue)) data.keepAttr = false;
  });
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "A") node.setAttribute("rel", "noopener noreferrer");
  });
}

function sanitizeHtml(html: string): string {
  // No DOM (server render): render nothing rather than unsanitised markup.
  if (!DOMPurify.isSupported) return "";
  ensureHooks();
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false });
}

export function toSafeNotesheetHtml(raw: string): string {
  if (HTML_TAG_PATTERN.test(raw)) return sanitizeHtml(raw); // Rich Text Editor output — sanitised, then rendered.
  return escapeHtml(raw).replace(/\r\n|\r|\n/g, "<br />"); // Legacy plain text — escape, then preserve line breaks.
}

// Compact prose styling for rendering stored notesheet/remark HTML inside a
// timeline/history entry (smaller than a page's primary notesheet document).
export const NOTESHEET_PROSE_CLASS = "prose prose-sm max-w-none leading-relaxed " +
  "[&_h1]:text-lg [&_h1]:font-bold [&_h1]:mt-2 [&_h1]:mb-1 " +
  "[&_h2]:text-base [&_h2]:font-bold [&_h2]:mt-2 [&_h2]:mb-1 " +
  "[&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-1.5 [&_h3]:mb-1 " +
  "[&_p]:mb-2 [&_ol]:pl-5 [&_ul]:pl-5 [&_li]:mb-0.5 [&_strong]:font-bold [&_mark]:rounded [&_mark]:px-0.5 [&_mark]:text-inherit " +
  "[&_table]:border-collapse [&_table]:my-2 [&_table]:w-full [&_table]:max-w-full [&_table]:table-fixed [&_td]:border [&_td]:border-gray-300 [&_td]:p-1.5 [&_td]:align-top [&_td]:break-words " +
  "[&_th]:border [&_th]:border-gray-300 [&_th]:p-1.5 [&_th]:bg-gray-50 [&_th]:align-top [&_th]:break-words " +
  "[&_img]:max-w-full [&_img]:h-auto [&_img]:inline-block";
