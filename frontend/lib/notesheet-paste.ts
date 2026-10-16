// Paste clean-up for the notesheet editor — makes text copied from MS Word,
// Google Docs, LibreOffice, web pages and PDFs land in the notesheet looking
// the way it looked where it was copied from.
//
// What Word puts on the clipboard is HTML whose formatting lives mostly in
// a <style> block (p.MsoNormal { font-size: 12pt; … }) and in inline
// styles mixed with Word-only "mso-*" properties. Lists are not real lists
// at all: each item is a <p style="mso-list:l0 level1 lfo1"> whose "1." or
// "•" is typed text inside a <span style="mso-list:Ignore">. A PDF viewer
// usually puts only plain text on the clipboard, with a line break at the
// end of every printed line.
//
// cleanPastedHtml() therefore:
//   1. applies the <style> block's class rules to the elements they target,
//   2. turns Word list paragraphs into real <ol>/<ul> (keeping the original
//      number/letter/roman style and start number; a numbering the browser
//      cannot draw, such as "1.1" or "(a)", is kept as typed text),
//   3. keeps only the CSS the notesheet can store (alignment, indents,
//      spacing, line height, font, size, colour, cell shading and borders,
//      column widths) — everything else is dropped,
//   4. moves paragraph-level font settings onto the text so the editor's
//      text-style marks can hold them.
// plainTextToHtml() rebuilds paragraphs from PDF-style wrapped lines.

const BLOCK_TAGS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "TD", "TH", "BLOCKQUOTE"]);
const CONTAINER_CHILD = "p, div, h1, h2, h3, h4, h5, h6, ul, ol, table, blockquote";

const FONT_PROPS = ["font-family", "font-size", "color", "font-weight", "font-style"] as const;
const BLOCK_CSS = ["text-align", "margin-left", "margin-right", "margin-top", "margin-bottom", "text-indent", "line-height"];
const INLINE_CSS = ["color", "background-color", "font-family", "font-size", "font-weight", "font-style", "text-decoration", "vertical-align", "line-height"];
const CELL_CSS = ["background-color", "vertical-align"];
const SIDES = ["top", "right", "bottom", "left"] as const;

const BULLET_MARKER = /^[·•o§▪■◦●○◆◇➢➤✓✔\-–—*•·]$/;
const SIMPLE_NUMBER = /^(\d{1,3}|[a-zA-Z]|[ivxlcdm]{1,6}|[IVXLCDM]{1,6})[.)]$/;
const ROMAN = /^[ivxlcdm]+$/i;

function romanToInt(s: string): number {
  const v: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  let total = 0;
  const t = s.toLowerCase();
  for (let i = 0; i < t.length; i++) {
    const cur = v[t[i]], next = v[t[i + 1]] ?? 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}

type ListKind = { tag: "ul" } | { tag: "ol"; type: "1" | "a" | "A" | "i" | "I"; start: number };

/** What kind of list a Word list marker ("1.", "b)", "iv.", "•") belongs to;
 * null when the browser cannot draw it (keep it as typed text). */
function classifyMarker(marker: string, symbolFont: boolean): ListKind | null {
  const m = marker.replace(/ /g, " ").trim();
  if (!m || BULLET_MARKER.test(m) || (symbolFont && m.length <= 2)) return { tag: "ul" };
  const n = SIMPLE_NUMBER.exec(m);
  if (!n) return null;
  const v = n[1];
  if (/^\d+$/.test(v)) return { tag: "ol", type: "1", start: parseInt(v, 10) };
  // A lone i / v / x is far more often roman than the 9th/22nd/24th letter.
  if (ROMAN.test(v) && (v.length > 1 || /^[ivx]$/i.test(v))) {
    return { tag: "ol", type: v === v.toLowerCase() ? "i" : "I", start: romanToInt(v) };
  }
  if (v.length === 1) {
    const lower = v.toLowerCase();
    return { tag: "ol", type: v === lower ? "a" : "A", start: lower.charCodeAt(0) - 96 };
  }
  return null;
}

/** Length in CSS px (Word uses pt / in / cm). */
function toPx(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(-?[\d.]+)\s*(px|pt|in|cm|mm)?$/i.exec(value.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] || "px").toLowerCase();
  const px = unit === "pt" ? n * 96 / 72 : unit === "in" ? n * 96 : unit === "cm" ? n * 96 / 2.54 : unit === "mm" ? n * 96 / 25.4 : n;
  return Number.isFinite(px) ? px : null;
}

const SYSTEM_TEXT = /^(windowtext|auto|initial|inherit|unset|currentcolor)$/i;

function cleanValue(prop: string, value: string): string | null {
  const v = value.trim();
  if (!v || /^(initial|inherit|unset|revert)$/i.test(v)) return null;
  if (/url\s*\(|expression|javascript|@import|\\/i.test(v)) return null;
  if (prop === "color" || prop === "background-color") {
    if (SYSTEM_TEXT.test(v) || /^transparent$/i.test(v) || /^rgba\([^)]*,\s*0\)$/i.test(v)) return null;
    // A white "highlight" is invisible on paper but shows as a box on the
    // tinted notesheet background — Word and web pages add it a lot.
    if (prop === "background-color" && /^(white|#fff(fff)?|rgb\(255,\s*255,\s*255\))$/i.test(v)) return null;
  }
  if (prop === "font-weight" && /^(normal|400)$/.test(v)) return null;
  if (prop === "font-style" && v === "normal") return null;
  if (prop === "text-decoration" && /^none/.test(v)) return null;
  if (prop === "vertical-align" && !/^(super|sub|top|middle|bottom)$/.test(v)) return null;
  if (prop === "line-height" && v === "normal") return null;
  if (prop === "font-family") return v.replace(/\s*,\s*/g, ", ");
  return v.length > 160 ? null : v;
}

/** Pulls the kept CSS properties off `el.style` as an ordered map. */
function readCss(el: HTMLElement, props: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const prop of props) {
    const raw = el.style.getPropertyValue(prop);
    const v = raw ? cleanValue(prop, raw) : null;
    if (v) out.set(prop, v);
  }
  return out;
}

function writeCss(el: HTMLElement, css: Map<string, string>) {
  const text = Array.from(css, ([k, v]) => `${k}: ${v}`).join("; ");
  if (text) el.setAttribute("style", text); else el.removeAttribute("style");
}

function rawStyle(el: Element): string {
  return el.getAttribute("style") ?? "";
}

/** Applies the <style> block's rules (p.MsoNormal, h1, span.MsoHyperlink…)
 * underneath each element's own inline style. */
function inlineStylesheet(doc: Document) {
  const cssText = Array.from(doc.querySelectorAll("style")).map((s) => s.textContent ?? "").join("\n");
  if (!cssText.trim() || typeof CSSStyleSheet === "undefined") return;
  let sheet: CSSStyleSheet;
  try {
    sheet = new CSSStyleSheet();
    // Word's sheet is wrapped in <!-- --> and carries @list / @page rules;
    // the parser skips what it does not understand.
    sheet.replaceSync(cssText.replace(/<!--|-->/g, ""));
  } catch {
    return;
  }
  const extra = new Map<Element, string>();
  for (const rule of Array.from(sheet.cssRules)) {
    if (!(rule instanceof CSSStyleRule)) continue;
    let targets: NodeListOf<Element>;
    try {
      targets = doc.body.querySelectorAll(rule.selectorText);
    } catch {
      continue;
    }
    targets.forEach((el) => extra.set(el, (extra.get(el) ?? "") + rule.style.cssText + ";"));
  }
  extra.forEach((css, el) => el.setAttribute("style", css + rawStyle(el)));
}

interface WordListItem { el: HTMLElement; level: number; listId: string; kind: ListKind | null; }

function readWordListItem(el: HTMLElement): WordListItem | null {
  const m = /mso-list:\s*(l\d+)\s+level(\d+)/i.exec(rawStyle(el));
  if (!m) return null;
  let marker = "";
  let symbolFont = false;
  el.querySelectorAll("span").forEach((span) => {
    if (/mso-list:\s*Ignore/i.test(rawStyle(span))) {
      marker += span.textContent ?? "";
      symbolFont ||= /Symbol|Wingdings/i.test(rawStyle(span) + (span.querySelector("[style]")?.getAttribute("style") ?? ""));
      span.remove();
    }
  });
  const kind = classifyMarker(marker, symbolFont);
  if (!kind && marker.trim()) {
    // Keep "1.1", "(a)", "Step 1:" exactly as typed.
    el.insertBefore(el.ownerDocument.createTextNode(`${marker.replace(/\s+$/, "")}  `), el.firstChild);
  }
  return { el, level: parseInt(m[2], 10), listId: m[1], kind };
}

function sameKind(a: ListKind, b: ListKind) {
  return a.tag === b.tag && (a.tag === "ul" || (b.tag === "ol" && a.type === b.type));
}

/** Word list paragraphs → nested <ol>/<ul>. */
function convertWordLists(doc: Document) {
  const all = Array.from(doc.body.querySelectorAll<HTMLElement>("p, h1, h2, h3, h4, h5, h6"))
    .filter((el) => /mso-list:\s*l\d+\s+level\d+/i.test(rawStyle(el)));
  const done = new Set<Element>();
  for (const first of all) {
    if (done.has(first)) continue;
    // A run of consecutive list paragraphs under the same parent.
    const run: WordListItem[] = [];
    let cur: Element | null = first;
    while (cur && all.includes(cur as HTMLElement) && !done.has(cur)) {
      done.add(cur);
      const item = readWordListItem(cur as HTMLElement);
      if (item) run.push(item);
      cur = cur.nextElementSibling;
    }
    const parent = first.parentNode;
    if (!parent) continue;
    const stack: { level: number; list: HTMLElement; kind: ListKind }[] = [];
    for (const item of run) {
      if (!item.kind) {
        // Not a drawable list: the paragraph stays (with its indent) and
        // ends any list that was open.
        stack.length = 0;
        continue;
      }
      while (stack.length && stack[stack.length - 1].level > item.level) stack.pop();
      let top = stack[stack.length - 1];
      if (top && top.level === item.level && !sameKind(top.kind, item.kind)) { stack.pop(); top = stack[stack.length - 1]; }
      if (!top || top.level < item.level) {
        const list = doc.createElement(item.kind.tag);
        if (item.kind.tag === "ol") {
          if (item.kind.type !== "1") list.setAttribute("type", item.kind.type);
          if (item.kind.start > 1) list.setAttribute("start", String(item.kind.start));
        }
        const parentLi = top?.list.lastElementChild;
        if (parentLi) parentLi.appendChild(list);
        else parent.insertBefore(list, item.el);
        stack.push({ level: item.level, list, kind: item.kind });
        top = stack[stack.length - 1];
      }
      const li = doc.createElement("li");
      const p = doc.createElement("p");
      // The list draws the indent and the number now.
      const css = readCss(item.el, [...BLOCK_CSS, ...FONT_PROPS]);
      ["margin-left", "margin-right", "text-indent"].forEach((k) => css.delete(k));
      writeCss(p, css);
      while (item.el.firstChild) p.appendChild(item.el.firstChild);
      li.appendChild(p);
      top.list.appendChild(li);
      item.el.remove();
    }
  }
}

/** Paragraph / cell font settings → onto their text (or child blocks), so
 * the editor's text-style marks can hold them. */
function pushFontsDown(doc: Document) {
  const blocks = Array.from(doc.body.querySelectorAll<HTMLElement>("p, div, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, table, tr, tbody"));
  for (const el of blocks) {
    const fonts = readCss(el, FONT_PROPS);
    // Headings and table headers are bold by their nature already.
    if (/^(H\d|TH)$/.test(el.tagName)) fonts.delete("font-weight");
    FONT_PROPS.forEach((p) => el.style.removeProperty(p));
    if (!fonts.size) continue;
    const childBlocks = Array.from(el.children).filter((c) => c.matches(CONTAINER_CHILD) || /^(TR|TD|TH|TBODY|THEAD|LI)$/.test(c.tagName));
    if (childBlocks.length) {
      for (const child of childBlocks as HTMLElement[]) {
        fonts.forEach((v, k) => { if (!child.style.getPropertyValue(k)) child.style.setProperty(k, v); });
      }
      continue;
    }
    if (!el.textContent?.trim() && !el.querySelector("img")) continue;
    const span = doc.createElement("span");
    writeCss(span, fonts);
    while (el.firstChild) span.appendChild(el.firstChild);
    el.appendChild(span);
  }
}

function cellBorders(el: HTMLElement): string | null {
  const parts: string[] = [];
  let any = false;
  for (const side of SIDES) {
    const style = el.style.getPropertyValue(`border-${side}-style`);
    if (!style) { parts.push(""); continue; }
    any = true;
    if (style === "none" || style === "hidden") { parts.push(`border-${side}: none`); continue; }
    const width = Math.min(4, Math.max(1, Math.round(toPx(el.style.getPropertyValue(`border-${side}-width`)) ?? 1)));
    const rawColor = el.style.getPropertyValue(`border-${side}-color`);
    const color = !rawColor || SYSTEM_TEXT.test(rawColor) ? "#000000" : rawColor;
    const line = /^(dashed|dotted|double)$/.test(style) ? style : "solid";
    parts.push(`border-${side}: ${width}px ${line} ${color}`);
  }
  return any ? parts.filter(Boolean).join("; ") : null;
}

/** Keeps only what the notesheet can store, per element. */
function normalizeStyles(doc: Document) {
  doc.body.querySelectorAll<HTMLElement>("*").forEach((el) => {
    const tag = el.tagName;
    const align = el.getAttribute("align");
    if (align && !el.style.textAlign && BLOCK_TAGS.has(tag)) el.style.textAlign = align.toLowerCase();
    el.removeAttribute("align");
    el.removeAttribute("class");
    el.removeAttribute("lang");
    el.removeAttribute("dir");

    if (tag === "TD" || tag === "TH") {
      const css = readCss(el, [...CELL_CSS, "text-align"]);
      const valign = el.getAttribute("valign");
      if (valign && !css.has("vertical-align")) css.set("vertical-align", valign.toLowerCase());
      if (!el.hasAttribute("colwidth")) {
        const w = toPx(el.style.getPropertyValue("width")) ?? toPx(el.getAttribute("width"));
        if (w && w > 0) el.setAttribute("colwidth", String(Math.round(w)));
      }
      const borders = cellBorders(el);
      writeCss(el, css);
      if (borders) el.setAttribute("style", [rawStyle(el), borders].filter(Boolean).join("; "));
      ["width", "valign", "nowrap", "height"].forEach((a) => el.removeAttribute(a));
      return;
    }
    if (tag === "TR") {
      const h = toPx(el.style.getPropertyValue("height"));
      writeCss(el, new Map(h ? [["height", `${Math.round(h)}px`]] : []));
      el.removeAttribute("height");
      return;
    }
    if (tag === "TABLE" || tag === "TBODY" || tag === "THEAD" || tag === "COLGROUP" || tag === "COL") {
      el.removeAttribute("style");
      return;
    }
    if (tag === "IMG") {
      const w = toPx(el.style.getPropertyValue("width")) ?? toPx(el.getAttribute("width"));
      const h = toPx(el.style.getPropertyValue("height")) ?? toPx(el.getAttribute("height"));
      el.removeAttribute("style");
      if (w) el.setAttribute("width", String(Math.round(w))); else el.removeAttribute("width");
      if (h) el.setAttribute("height", String(Math.round(h))); else el.removeAttribute("height");
      return;
    }
    if (tag === "OL" || tag === "UL") {
      // Google Docs puts the list style on the <li>s instead.
      const firstLi = el.querySelector(":scope > li") as HTMLElement | null;
      const lst = (el.style.listStyleType || firstLi?.style.listStyleType || "").toLowerCase();
      const type = { "lower-alpha": "a", "lower-latin": "a", "upper-alpha": "A", "upper-latin": "A", "lower-roman": "i", "upper-roman": "I" }[lst];
      if (tag === "OL" && type && !el.hasAttribute("type")) el.setAttribute("type", type);
      el.removeAttribute("style");
      return;
    }
    const props = BLOCK_TAGS.has(tag) ? BLOCK_CSS : INLINE_CSS;
    const css = readCss(el, tag === "MARK" ? [...props, "background-color"] : props);
    if (BLOCK_TAGS.has(tag)) {
      // Word's 0in / 0pt margins: written as 0 so they still override the
      // editor's default paragraph spacing.
      css.forEach((v, k) => { if (/^-?0(\.0+)?(in|pt|cm|px|mm)?$/.test(v)) css.set(k, "0"); });
      if (tag === "LI") ["margin-left", "text-indent"].forEach((k) => css.delete(k));
    }
    writeCss(el, css);
  });
}

export interface PasteResult { html: string; droppedImages: number; }

/** Cleans clipboard HTML. Returns it unchanged when it was copied from the
 * notesheet editor itself (ProseMirror marks that with data-pm-slice). */
export function cleanPastedHtml(input: string): PasteResult {
  if (typeof DOMParser === "undefined" || /data-pm-slice/.test(input)) return { html: input, droppedImages: 0 };
  const html = input
    // Word's "downlevel-hidden" blocks (VML shapes, fallbacks) — drop.
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, "")
    // Word's "downlevel-revealed" markers — keep what is between them.
    .replace(/<!\[if[^\]]*\]>|<!\[endif\]>/gi, "")
    // Office namespace tags (<o:p>, <w:…>, <v:…>, <m:…>) — keep their text.
    .replace(/<\/?(o|w|v|m|st\d*):[^>]*>/gi, "");
  const doc = new DOMParser().parseFromString(html, "text/html");
  inlineStylesheet(doc);
  doc.querySelectorAll("style, meta, link, title, script, xml, template, noscript, iframe, object, embed").forEach((n) => n.remove());

  // Pictures must be embedded; a Word picture arrives as a file:/// path
  // the browser cannot read.
  let droppedImages = 0;
  doc.querySelectorAll("img").forEach((img) => {
    if (!/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(img.getAttribute("src") ?? "")) { img.remove(); droppedImages++; }
  });

  // Google Docs wraps everything in <b style="font-weight:normal" id="docs-internal-guid-…">.
  doc.querySelectorAll<HTMLElement>("b[id^='docs-internal-guid']").forEach((b) => {
    const frag = doc.createDocumentFragment();
    while (b.firstChild) frag.appendChild(b.firstChild);
    b.replaceWith(frag);
  });
  // Word marks tab stops with a run of spaces; keep the gap.
  doc.querySelectorAll<HTMLElement>("span").forEach((s) => {
    if (/mso-tab-count/i.test(rawStyle(s))) s.textContent = "    ";
  });

  convertWordLists(doc);
  pushFontsDown(doc);
  normalizeStyles(doc);
  // Spans left with nothing to say — unwrap.
  doc.querySelectorAll("span:not([style])").forEach((s) => {
    const frag = doc.createDocumentFragment();
    while (s.firstChild) frag.appendChild(s.firstChild);
    s.replaceWith(frag);
  });
  return { html: doc.body.innerHTML, droppedImages };
}

// ── Plain text (PDF viewers, Notepad, e-mail) ────────────────────────────────

const LIST_LINE = /^\s*([•●▪■◦○\-–*•·]|\(?(\d{1,3}|[a-zA-Z]|[ivxlcdm]{1,6})[.)])\s+/i;
const BULLET_LINE = /^\s*[•●▪■◦○•·]\s+/;

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Plain text → paragraphs. A PDF ends every printed line with a newline;
 * those lines are joined back into their paragraph (and "infor-\nmation"
 * is re-joined), while short lines, blank lines and list items still start
 * a new paragraph. Text that is not wrapped that way (short lines, e.g. an
 * address) keeps every line. "•" items become a bulleted list. */
export function plainTextToHtml(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\f/g, "\n").split("\n").map((l) => l.replace(/\s+$/, ""));
  const lengths = lines.map((l) => l.trim().length).filter((n) => n > 0).sort((a, b) => a - b);
  const typical = lengths.length ? lengths[Math.floor(lengths.length * 0.9)] ?? lengths[lengths.length - 1] : 0;
  const wrapped = lengths.length >= 3 && typical >= 50;
  const fullLine = (l: string) => l.trim().length >= typical * 0.7;

  type Block = { bullet: boolean; text: string; lastLine: string };
  const blocks: Block[] = [];
  let current: Block | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, "    ");
    if (!line.trim()) { current = null; continue; }
    const isList = LIST_LINE.test(line);
    if (current && wrapped && !isList && fullLine(current.lastLine)) {
      const prev = current.text;
      if (/[A-Za-z]-$/.test(prev) && /^[a-z]/.test(line.trim())) current.text = prev.slice(0, -1) + line.trim();
      else current.text = `${prev} ${line.trim()}`;
      current.lastLine = line;
      continue;
    }
    const bullet = BULLET_LINE.test(line);
    current = {
      bullet,
      text: (bullet ? line.replace(BULLET_LINE, "") : line).replace(/^\s+/, (sp) => " ".repeat(sp.length)),
      lastLine: line,
    };
    blocks.push(current);
  }

  let html = "";
  let inList = false;
  for (const b of blocks) {
    if (b.bullet && !inList) { html += "<ul>"; inList = true; }
    if (!b.bullet && inList) { html += "</ul>"; inList = false; }
    const body = escapeText(b.text);
    html += b.bullet ? `<li><p>${body}</p></li>` : `<p>${body}</p>`;
  }
  if (inList) html += "</ul>";
  return html;
}
