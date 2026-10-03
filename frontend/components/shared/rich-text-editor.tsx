"use client";
// Shared Tiptap WYSIWYG editor — the notesheet-authoring component reused by
// both New File creation and Draft editing, so the extension set, paste
// cleanup, and toolbar are defined in exactly one place.
//
// Word-style features: pictures (paste a screenshot, drop a file, or use the
// Insert Image button; shrunk in the browser before they are stored; resize
// by dragging a corner or from the toolbar) and tables (any size, add/remove
// rows and columns, merge/split cells, header row, table / column width, row
// height, cell colour, drag a column border to resize).
import { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, useEditorState } from "@tiptap/react";
import { findParentNode, type Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableMap, selectionCell } from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";
import { toast } from "sonner";
import {
  Bold, Italic, Underline as UIcon, AlignLeft, AlignCenter, AlignRight, List, ListOrdered,
  Grid2x2, Highlighter, ImagePlus, Trash2, Merge, Split, PaintBucket,
} from "lucide-react";

// This project has no @tailwindcss/typography plugin, so the bare "prose"
// class applies no styling — Tailwind's Preflight reset otherwise strips
// default list markers (list-style: none) and heading typography (font-size/
// weight: inherit), which made Bullet List / Numbered List / H1-H3 (and
// table borders) look non-functional even though the underlying Tiptap
// commands were always executing correctly and producing valid HTML.
export const NOTESHEET_EDITOR_CONTENT_CLASS =
  "prose max-w-none focus:outline-none min-h-[400px] p-5 text-base leading-relaxed " +
  "[&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mt-4 [&_h1]:mb-2 " +
  "[&_h2]:text-xl [&_h2]:font-bold [&_h2]:mt-4 [&_h2]:mb-2 " +
  "[&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 " +
  "[&_p]:mb-3 [&_strong]:font-bold " +
  "[&_mark]:rounded [&_mark]:px-0.5 [&_mark]:text-inherit " +
  "[&_ul]:list-disc [&_ul]:pl-6 [&_ul]:mb-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:mb-3 [&_li]:mb-1 " +
  "[&_table]:border-collapse [&_table]:my-3 [&_table]:w-full [&_td]:border [&_td]:border-gray-300 [&_td]:p-2 [&_th]:border [&_th]:border-gray-300 [&_th]:p-2 [&_th]:bg-gray-50 " +
  "[&_img]:max-w-full [&_img]:h-auto [&_img]:inline-block [&_img]:align-bottom";

// ── Pictures ────────────────────────────────────────────────────────────────

const IMAGE_MAX_DIMENSION = 1600;           // longest side after shrinking, px
const IMAGE_MAX_DATA_URL_CHARS = 3_300_000; // ≈ 2.5 MB of image data
const IMAGE_PNG_KEEP_CHARS = 900_000;       // keep lossless PNG only while it stays small
const GIF_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp)$/i;

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Could not read the image."));
    r.readAsDataURL(file);
  });
}

function drawScaled(bitmap: ImageBitmap, scale: number, flatten: boolean): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser could not process the image.");
  if (flatten) { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Shrinks a picture so it stores and prints well: longest side ≤ 1600 px,
 * lossless PNG while that stays small, otherwise JPEG at the best quality
 * that fits. The notesheet is saved as HTML, so image size is stored size. */
export async function imageFileToDataUrl(file: File): Promise<string> {
  if (!IMAGE_TYPES.test(file.type)) throw new Error("Only PNG, JPG, GIF or WebP pictures can be added.");
  if (file.type === "image/gif") {
    // A canvas would drop the animation, so a GIF is kept as it is.
    if (file.size > GIF_MAX_BYTES) throw new Error("This GIF is larger than 2 MB. Please use a smaller one.");
    return readAsDataUrl(file);
  }
  const bitmap = await createImageBitmap(file);
  try {
    let scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 4; attempt++) {
      if (file.type !== "image/jpeg") {
        const png = drawScaled(bitmap, scale, false).toDataURL("image/png");
        if (png.length <= IMAGE_PNG_KEEP_CHARS) return png;
      }
      const flat = drawScaled(bitmap, scale, true);
      for (const quality of [0.88, 0.78, 0.66, 0.55]) {
        const jpeg = flat.toDataURL("image/jpeg", quality);
        if (jpeg.length <= IMAGE_MAX_DATA_URL_CHARS) return jpeg;
      }
      scale *= 0.75;
    }
    throw new Error("This picture is too large to add, even after shrinking it.");
  } finally {
    bitmap.close();
  }
}

/** Inserts picture files at the cursor (or at `pos`). Failures are reported
 * per file; the rest are still added. */
export async function insertImageFiles(view: EditorView, files: File[], pos?: number) {
  const imageNode = view.state.schema.nodes.image;
  if (!imageNode) return;
  let at = pos;
  for (const file of files) {
    try {
      const src = await imageFileToDataUrl(file);
      const node = imageNode.create({ src });
      const { state } = view;
      const tr = at === undefined
        ? state.tr.replaceSelectionWith(node)
        : state.tr.insert(Math.min(at, state.doc.content.size), node);
      view.dispatch(tr.scrollIntoView());
      if (at !== undefined) at += node.nodeSize;
    } catch (err) {
      toast.error((err as Error)?.message || "Could not add this picture.");
    }
  }
}

// Tiptap's built-in resizable picture view ignores the saved width/height
// when it draws (so a resized picture snaps back to full size on reopening)
// and does not repaint when the size is changed from the toolbar. This view
// applies the stored size, repaints on change, and has corner handles.
const MIN_IMAGE_PX = 40;
const HANDLES = [
  { name: "top-left", dx: -1, css: "top:-5px;left:-5px;cursor:nwse-resize" },
  { name: "top-right", dx: 1, css: "top:-5px;right:-5px;cursor:nesw-resize" },
  { name: "bottom-left", dx: -1, css: "bottom:-5px;left:-5px;cursor:nesw-resize" },
  { name: "bottom-right", dx: 1, css: "bottom:-5px;right:-5px;cursor:nwse-resize" },
] as const;

const ResizableImage = Image.extend({
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const wrap = document.createElement("span");
      wrap.setAttribute("data-image-wrap", "");
      wrap.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%;vertical-align:bottom";
      const img = document.createElement("img");
      img.draggable = false;
      img.style.maxWidth = "100%";
      wrap.appendChild(img);

      const paint = (n: typeof node) => {
        img.src = n.attrs.src;
        img.alt = n.attrs.alt ?? "";
        if (n.attrs.title) img.title = n.attrs.title; else img.removeAttribute("title");
        const w = n.attrs.width as number | null;
        const h = n.attrs.height as number | null;
        img.style.width = w ? `${w}px` : "";
        img.style.height = w ? (h ? `${h}px` : "auto") : "";
      };
      paint(node);

      for (const handle of HANDLES) {
        const el = document.createElement("span");
        el.setAttribute("data-image-handle", handle.name);
        el.style.cssText = `position:absolute;${handle.css}`;
        el.addEventListener("pointerdown", (event) => {
          if (!editor.isEditable) return;
          event.preventDefault();
          event.stopPropagation();
          el.setPointerCapture(event.pointerId);
          const startX = event.clientX;
          const startWidth = img.getBoundingClientRect().width;
          const ratio = img.naturalHeight && img.naturalWidth ? img.naturalHeight / img.naturalWidth : img.getBoundingClientRect().height / startWidth;
          const maxWidth = Math.max(MIN_IMAGE_PX, (editor.view.dom as HTMLElement).clientWidth - 40);
          let width = startWidth;
          const move = (e: PointerEvent) => {
            width = Math.min(maxWidth, Math.max(MIN_IMAGE_PX, startWidth + (e.clientX - startX) * handle.dx));
            img.style.width = `${width}px`;
            img.style.height = `${width * ratio}px`;
          };
          const up = () => {
            el.removeEventListener("pointermove", move);
            el.removeEventListener("pointerup", up);
            el.removeEventListener("pointercancel", up);
            const pos = getPos();
            if (pos === undefined) return;
            editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, {
              ...current.attrs, width: Math.round(width), height: Math.round(width * ratio),
            }));
          };
          el.addEventListener("pointermove", move);
          el.addEventListener("pointerup", up);
          el.addEventListener("pointercancel", up);
        });
        wrap.appendChild(el);
      }

      return {
        dom: wrap,
        update(updated) {
          if (updated.type !== current.type) return false;
          current = updated;
          paint(updated);
          return true;
        },
        stopEvent: (event) => (event.target as HTMLElement | null)?.hasAttribute?.("data-image-handle") ?? false,
        ignoreMutation: () => true,
      };
    };
  },
});

function pictureFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
}

function transformPastedHTML(html: string): string {
  // Remove MS Word / LibreOffice proprietary tags and attributes while
  // keeping structural HTML (headings, bold, italic, lists, tables)
  return html
    .replace(/<\/?o:[^>]*>/gi, "")
    .replace(/<\/?w:[^>]*>/gi, "")
    .replace(/<\/?m:[^>]*>/gi, "")
    .replace(/<\/?v:[^>]*>/gi, "")
    .replace(/<!--\[if[^>]*>[\s\S]*?<!\[endif\]-->/gi, "")
    .replace(/\s*class="[^"]*Mso[^"]*"/gi, "")
    .replace(/\s*class="[^"]*"/gi, "")
    .replace(/\s*style="[^"]*mso-[^"]*"/gi, "")
    .replace(/\s*style="[^"]*font-family:[^"]*"/gi, "")
    .replace(/\s*style="[^"]*font-size:[^"]*"/gi, "")
    // Pictures that point at a file on someone's computer or a web address
    // cannot be stored — only embedded pictures survive a paste.
    .replace(/<img\b(?![^>]*\ssrc="data:image\/)[^>]*>/gi, "")
    .replace(/<p[^>]*>(\s|&nbsp;)*<\/p>/gi, "")
    .replace(/\s*lang="[^"]*"/gi, "");
}

// ── Tables ──────────────────────────────────────────────────────────────────

const shading = {
  backgroundColor: {
    default: null,
    parseHTML: (el: HTMLElement) => el.style.backgroundColor || null,
    renderHTML: (attrs: Record<string, unknown>) =>
      attrs.backgroundColor ? { style: `background-color: ${attrs.backgroundColor}` } : {},
  },
};

// Row height and cell colour are stored as ordinary inline styles, so they
// show up identically in the saved notesheet, the viewers and the PDF.
const TableRowSized = TableRow.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      rowHeight: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const h = parseInt(el.style.height, 10);
          return Number.isFinite(h) ? h : null;
        },
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.rowHeight ? { style: `height: ${attrs.rowHeight}px` } : {},
      },
    };
  },
});
const TableCellShaded = TableCell.extend({
  addAttributes() { return { ...this.parent?.(), ...shading }; },
});
const TableHeaderShaded = TableHeader.extend({
  addAttributes() { return { ...this.parent?.(), ...shading }; },
});

const MIN_COLUMN_PX = 30;

function currentTable(editor: Editor) {
  return findParentNode((n) => n.type.name === "table")(editor.state.selection);
}

/** Gives every column of the table the widths returned by `widths(columnCount)`. */
function applyColumnWidths(editor: Editor, widths: (columns: number) => number[]) {
  const table = currentTable(editor);
  if (!table) return;
  const map = TableMap.get(table.node);
  const cols = widths(map.width).map((w) => Math.max(MIN_COLUMN_PX, Math.round(w)));
  const tr = editor.state.tr;
  const seen = new Set<number>();
  map.map.forEach((cellPos, i) => {
    if (seen.has(cellPos)) return;
    seen.add(cellPos);
    const cell = table.node.nodeAt(cellPos);
    if (!cell) return;
    const first = i % map.width;
    const span = (cell.attrs.colspan as number) || 1;
    tr.setNodeMarkup(table.start + cellPos, undefined, { ...cell.attrs, colwidth: cols.slice(first, first + span) });
  });
  editor.view.dispatch(tr);
}

/** Width of the writing area in px — what "full width" means for a table. */
function pageWidthPx(editor: Editor): number {
  const dom = editor.view.dom as HTMLElement;
  const cs = getComputedStyle(dom);
  return Math.max(200, dom.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
}

function setTableWidth(editor: Editor, widthPx: number) {
  applyColumnWidths(editor, (n) => Array.from({ length: n }, () => widthPx / n));
}

function currentColumnIndex(editor: Editor): number | null {
  const table = currentTable(editor);
  if (!table) return null;
  try {
    const $cell = selectionCell(editor.state);
    return TableMap.get(table.node).colCount($cell.pos - table.start);
  } catch {
    return null;
  }
}

function setCurrentColumnWidth(editor: Editor, widthPx: number) {
  const col = currentColumnIndex(editor);
  const table = currentTable(editor);
  if (col === null || !table) return;
  const map = TableMap.get(table.node);
  // Keep the other columns as they are; unsized ones get an even share.
  const even = pageWidthPx(editor) / map.width;
  const dom = editor.view.nodeDOM(table.pos) as HTMLElement | null;
  const widths = Array.from({ length: map.width }, (_, c) => {
    const colEl = dom?.querySelectorAll("col")[c] as HTMLElement | undefined;
    return parseFloat(colEl?.style.width ?? "") || even;
  });
  widths[col] = widthPx;
  applyColumnWidths(editor, () => widths);
}

function setAllRowHeights(editor: Editor, heightPx: number | null) {
  const table = currentTable(editor);
  if (!table) return;
  const tr = editor.state.tr;
  table.node.forEach((row, offset) => {
    tr.setNodeMarkup(table.start + offset, undefined, { ...row.attrs, rowHeight: heightPx });
  });
  editor.view.dispatch(tr);
}

// ── Toolbar pieces ──────────────────────────────────────────────────────────

const HIGHLIGHT_COLORS: { label: string; value: string }[] = [
  { label: "Yellow", value: "#FEF08A" },
  { label: "Green", value: "#BBF7D0" },
  { label: "Pink", value: "#FBCFE8" },
  { label: "Blue", value: "#BFDBFE" },
  { label: "Grey", value: "#E5E7EB" },
];

type RTEditor = NonNullable<ReturnType<typeof useRichTextEditor>>;

const BTN = "p-2 rounded-lg transition-colors text-gray-600 hover:bg-gray-200";
const BTN_ACTIVE = "p-2 rounded-lg transition-colors bg-[#0D6E6E] text-white";
const SMALL_BTN = "px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-40 disabled:hover:bg-transparent";
const SEP = <div className="w-px bg-gray-200 mx-1" />;

function Popover({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-10" onMouseDown={onClose} />
      <div className="absolute z-20 mt-1 left-0 bg-white border border-gray-200 rounded-xl shadow-lg p-3">{children}</div>
    </>
  );
}

function HighlightMenu({ editor, active }: { editor: RTEditor; active: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" title="Highlight text"
        onMouseDown={(e) => { e.preventDefault(); setOpen((o) => !o); }}
        className={active ? BTN_ACTIVE : BTN}>
        <Highlighter size={15} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <div className="flex items-center gap-1.5">
          {HIGHLIGHT_COLORS.map((c) => (
            <button key={c.value} type="button" title={c.label}
              onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().setHighlight({ color: c.value }).run(); setOpen(false); }}
              className="w-6 h-6 rounded-md border border-gray-300 hover:scale-110 transition-transform"
              style={{ backgroundColor: c.value }} />
          ))}
          <div className="w-px bg-gray-200 self-stretch mx-0.5" />
          <button type="button" title="Remove highlight"
            onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().unsetHighlight().run(); setOpen(false); }}
            className="px-2 h-6 text-xs font-medium text-gray-600 rounded-md hover:bg-gray-100">Clear</button>
        </div>
      </Popover>
    </div>
  );
}

const GRID_ROWS = 8;
const GRID_COLS = 10;

function InsertTableMenu({ editor }: { editor: RTEditor }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState({ r: 0, c: 0 });
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const [header, setHeader] = useState(true);

  function insert(r: number, c: number) {
    const rr = Math.min(50, Math.max(1, Math.round(r) || 1));
    const cc = Math.min(12, Math.max(1, Math.round(c) || 1));
    editor.chain().focus().insertTable({ rows: rr, cols: cc, withHeaderRow: header }).run();
    setOpen(false);
  }

  return (
    <div className="relative">
      <button type="button" title="Insert table"
        onMouseDown={(e) => { e.preventDefault(); setOpen((o) => !o); }}
        className={BTN}>
        <Grid2x2 size={15} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <p className="text-xs font-semibold text-gray-600 mb-2">
          {hover.r ? `${hover.r} × ${hover.c} table` : "Choose the table size"}
        </p>
        <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${GRID_COLS}, 1.25rem)` }}
          onMouseLeave={() => setHover({ r: 0, c: 0 })}>
          {Array.from({ length: GRID_ROWS * GRID_COLS }, (_, i) => {
            const r = Math.floor(i / GRID_COLS) + 1;
            const c = (i % GRID_COLS) + 1;
            const on = r <= hover.r && c <= hover.c;
            return (
              <button key={i} type="button" aria-label={`${r} rows by ${c} columns`}
                onMouseEnter={() => setHover({ r, c })}
                onMouseDown={(e) => { e.preventDefault(); insert(r, c); }}
                className={`w-5 h-5 border rounded-sm ${on ? "bg-[#0D6E6E]/25 border-[#0D6E6E]" : "border-gray-300 bg-white"}`} />
            );
          })}
        </div>
        <div className="mt-3 pt-3 border-t border-gray-100 flex items-end gap-2">
          <label className="text-xs text-gray-600">Rows
            <input type="number" min={1} max={50} value={rows} onChange={(e) => setRows(Number(e.target.value))}
              className="block w-16 mt-0.5 border border-gray-300 rounded-md px-2 py-1 text-sm" />
          </label>
          <label className="text-xs text-gray-600">Columns
            <input type="number" min={1} max={12} value={cols} onChange={(e) => setCols(Number(e.target.value))}
              className="block w-16 mt-0.5 border border-gray-300 rounded-md px-2 py-1 text-sm" />
          </label>
          <button type="button" onMouseDown={(e) => { e.preventDefault(); insert(rows, cols); }}
            className="px-3 py-1.5 rounded-md bg-[#0D6E6E] text-white text-xs font-semibold hover:bg-[#178F8F]">Insert</button>
        </div>
        <label className="mt-2 flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
          <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> First row is a header
        </label>
      </Popover>
    </div>
  );
}

/** Number box that applies on Enter or when it loses focus. */
function PxInput({ label, title, onApply, placeholder }: {
  label: string; title: string; placeholder: string; onApply: (px: number) => void;
}) {
  const [value, setValue] = useState("");
  const apply = () => {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) onApply(n);
    setValue("");
  };
  return (
    <label className="flex items-center gap-1 text-xs text-gray-600" title={title}>
      {label}
      <input type="number" min={1} value={value} placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } }}
        onBlur={apply}
        className="w-16 border border-gray-300 rounded-md px-1.5 py-1 text-xs" />
      <span className="text-gray-400">px</span>
    </label>
  );
}

const CELL_COLORS = ["#FEF08A", "#BBF7D0", "#FBCFE8", "#BFDBFE", "#E5E7EB", "#FED7AA"];

function TableControls({ editor }: { editor: RTEditor }) {
  const [colorOpen, setColorOpen] = useState(false);
  const run = (fn: () => void) => (e: React.MouseEvent) => { e.preventDefault(); fn(); };
  const chain = () => editor.chain().focus();
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5 px-4 py-2 border-b border-gray-100 bg-[#F4FAF9]">
      <span className="text-xs font-bold text-[#0D6E6E] mr-1">Table</span>
      <button type="button" className={SMALL_BTN} onMouseDown={run(() => chain().addRowBefore().run())}>Row above</button>
      <button type="button" className={SMALL_BTN} onMouseDown={run(() => chain().addRowAfter().run())}>Row below</button>
      <button type="button" className={SMALL_BTN} onMouseDown={run(() => chain().deleteRow().run())}>Delete row</button>
      {SEP}
      <button type="button" className={SMALL_BTN} onMouseDown={run(() => chain().addColumnBefore().run())}>Column left</button>
      <button type="button" className={SMALL_BTN} onMouseDown={run(() => chain().addColumnAfter().run())}>Column right</button>
      <button type="button" className={SMALL_BTN} onMouseDown={run(() => chain().deleteColumn().run())}>Delete column</button>
      {SEP}
      <button type="button" title="Merge the selected cells (drag across cells first)" className={SMALL_BTN}
        onMouseDown={run(() => chain().mergeCells().run())}><Merge size={13} className="inline -mt-0.5 mr-1" />Merge</button>
      <button type="button" title="Split a merged cell" className={SMALL_BTN}
        onMouseDown={run(() => chain().splitCell().run())}><Split size={13} className="inline -mt-0.5 mr-1" />Split</button>
      <button type="button" className={SMALL_BTN} onMouseDown={run(() => chain().toggleHeaderRow().run())}>Header row</button>
      {SEP}
      <div className="relative">
        <button type="button" title="Cell colour" className={SMALL_BTN}
          onMouseDown={run(() => setColorOpen((o) => !o))}><PaintBucket size={13} className="inline -mt-0.5 mr-1" />Colour</button>
        <Popover open={colorOpen} onClose={() => setColorOpen(false)}>
          <div className="flex items-center gap-1.5">
            {CELL_COLORS.map((c) => (
              <button key={c} type="button" title={c}
                onMouseDown={run(() => { chain().setCellAttribute("backgroundColor", c).run(); setColorOpen(false); })}
                className="w-6 h-6 rounded-md border border-gray-300 hover:scale-110 transition-transform"
                style={{ backgroundColor: c }} />
            ))}
            <button type="button" className="px-2 h-6 text-xs font-medium text-gray-600 rounded-md hover:bg-gray-100"
              onMouseDown={run(() => { chain().setCellAttribute("backgroundColor", null).run(); setColorOpen(false); })}>None</button>
          </div>
        </Popover>
      </div>
      {SEP}
      <span className="text-xs text-gray-500 mr-0.5">Width</span>
      {([["Full", 1], ["¾", 0.75], ["½", 0.5]] as const).map(([label, f]) => (
        <button key={label} type="button" title={`Table width: ${Math.round(f * 100)}% of the page`} className={SMALL_BTN}
          onMouseDown={run(() => setTableWidth(editor, pageWidthPx(editor) * f))}>{label}</button>
      ))}
      <PxInput label="Table" title="Total table width in pixels — type a number and press Enter"
        placeholder="width" onApply={(px) => setTableWidth(editor, px)} />
      <PxInput label="Column" title="Width of the current column in pixels — type a number and press Enter"
        placeholder="width" onApply={(px) => setCurrentColumnWidth(editor, px)} />
      <PxInput label="Row" title="Height of the current row in pixels — type a number and press Enter"
        placeholder="height" onApply={(px) => editor.chain().focus().updateAttributes("tableRow", { rowHeight: Math.round(px) }).run()} />
      <button type="button" title="Give every row the height of the current row" className={SMALL_BTN}
        onMouseDown={run(() => {
          const h = editor.getAttributes("tableRow").rowHeight as number | null;
          setAllRowHeights(editor, h ?? null);
        })}>All rows alike</button>
      {SEP}
      <button type="button" title="Delete the whole table"
        className={`${SMALL_BTN} text-red-600 hover:bg-red-50`}
        onMouseDown={run(() => chain().deleteTable().run())}><Trash2 size={13} className="inline -mt-0.5 mr-1" />Delete table</button>
    </div>
  );
}

function setImageWidth(editor: Editor, size: number | "original") {
  const { selection } = editor.state;
  const dom = editor.view.nodeDOM(selection.from) as HTMLElement | null;
  const img = dom instanceof HTMLImageElement ? dom : dom?.querySelector("img");
  const nw = img?.naturalWidth ?? 0;
  const nh = img?.naturalHeight ?? 0;
  if (!nw || !nh) return;
  const width = size === "original" ? Math.min(nw, pageWidthPx(editor)) : Math.round(pageWidthPx(editor) * size);
  // Changing the size drops the selection — select the picture again so its
  // handles and this toolbar stay available for the next adjustment.
  editor.chain().focus()
    .updateAttributes("image", { width, height: Math.round((width * nh) / nw) })
    .setNodeSelection(selection.from)
    .run();
}

function ImageControls({ editor }: { editor: RTEditor }) {
  const run = (fn: () => void) => (e: React.MouseEvent) => { e.preventDefault(); fn(); };
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5 px-4 py-2 border-b border-gray-100 bg-[#F4FAF9]">
      <span className="text-xs font-bold text-[#0D6E6E] mr-1">Picture</span>
      <span className="text-xs text-gray-500">Size</span>
      {([["25%", 0.25], ["50%", 0.5], ["75%", 0.75], ["100%", 1]] as const).map(([label, f]) => (
        <button key={label} type="button" className={SMALL_BTN} onMouseDown={run(() => setImageWidth(editor, f))}>{label}</button>
      ))}
      <button type="button" className={SMALL_BTN} onMouseDown={run(() => setImageWidth(editor, "original"))}>Original</button>
      <span className="text-xs text-gray-400 mx-1">or drag a corner</span>
      {SEP}
      <span className="text-xs text-gray-400">Use the align buttons to position it</span>
      {SEP}
      <button type="button" className={`${SMALL_BTN} text-red-600 hover:bg-red-50`}
        onMouseDown={run(() => editor.chain().focus().deleteSelection().run())}>
        <Trash2 size={13} className="inline -mt-0.5 mr-1" />Delete picture
      </button>
    </div>
  );
}

// ── Editor ──────────────────────────────────────────────────────────────────

export function useRichTextEditor({ content, onChange, editable = true }: {
  content: string;
  onChange?: (html: string) => void;
  editable?: boolean;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      // Inline, like a Word "in line with text" picture: it sits in a
      // paragraph, so the align buttons centre / right-align it.
      ResizableImage.configure({ inline: true, allowBase64: true }),
      Table.configure({ resizable: true, cellMinWidth: MIN_COLUMN_PX }),
      TableRowSized,
      TableCellShaded,
      TableHeaderShaded,
    ],
    content,
    editable,
    editorProps: {
      attributes: { class: NOTESHEET_EDITOR_CONTENT_CLASS },
      transformPastedHTML,
      // A screenshot (or a picture copied from anywhere) arrives as an image
      // file on the clipboard. When text comes with it (Word, a web page) the
      // normal paste keeps the formatting instead.
      handlePaste(view, event) {
        const cd = event.clipboardData;
        if (!cd) return false;
        const files = pictureFiles(cd.files);
        if (files.length === 0 || cd.getData("text/plain").trim()) return false;
        event.preventDefault();
        void insertImageFiles(view, files);
        return true;
      },
      handleDrop(view, event, _slice, moved) {
        if (moved) return false;
        const files = pictureFiles(event.dataTransfer?.files);
        if (files.length === 0) return false;
        event.preventDefault();
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        void insertImageFiles(view, files, at);
        return true;
      },
    },
    onUpdate: ({ editor }) => onChange?.(editor.getHTML()),
  });

  useEffect(() => {
    if (editor) editor.setEditable(editable);
  }, [editor, editable]);

  return editor;
}

export function RichTextToolbar({ editor }: { editor: ReturnType<typeof useRichTextEditor> }) {
  // The editor does not re-render the toolbar on every selection change by
  // itself — subscribe to just what the toolbar shows.
  const state = useEditorState({
    editor,
    selector: ({ editor: ed }) => ({
      bold: !!ed?.isActive("bold"),
      italic: !!ed?.isActive("italic"),
      underline: !!ed?.isActive("underline"),
      highlight: !!ed?.isActive("highlight"),
      bullet: !!ed?.isActive("bulletList"),
      ordered: !!ed?.isActive("orderedList"),
      heading: ([1, 2, 3] as const).find((l) => ed?.isActive("heading", { level: l })) ?? 0,
      inTable: !!ed?.isActive("table"),
      onImage: !!ed?.isActive("image"),
    }),
  });
  const fileInput = useRef<HTMLInputElement>(null);
  if (!editor || !state) return null;

  const mark = (cmd: () => void) => (e: React.MouseEvent) => { e.preventDefault(); cmd(); };
  return (
    <div>
      <div className="flex flex-wrap gap-1 px-4 py-2 border-b border-gray-100 bg-gray-50">
        <button type="button" title="Bold" className={state.bold ? BTN_ACTIVE : BTN}
          onMouseDown={mark(() => editor.chain().focus().toggleBold().run())}><Bold size={15} /></button>
        <button type="button" title="Italic" className={state.italic ? BTN_ACTIVE : BTN}
          onMouseDown={mark(() => editor.chain().focus().toggleItalic().run())}><Italic size={15} /></button>
        <button type="button" title="Underline" className={state.underline ? BTN_ACTIVE : BTN}
          onMouseDown={mark(() => editor.chain().focus().toggleUnderline().run())}><UIcon size={15} /></button>
        <HighlightMenu editor={editor} active={state.highlight} />
        {SEP}
        <button type="button" title="Align left" className={BTN} onMouseDown={mark(() => editor.chain().focus().setTextAlign("left").run())}><AlignLeft size={15} /></button>
        <button type="button" title="Centre" className={BTN} onMouseDown={mark(() => editor.chain().focus().setTextAlign("center").run())}><AlignCenter size={15} /></button>
        <button type="button" title="Align right" className={BTN} onMouseDown={mark(() => editor.chain().focus().setTextAlign("right").run())}><AlignRight size={15} /></button>
        {SEP}
        <button type="button" title="Bulleted list" className={state.bullet ? BTN_ACTIVE : BTN}
          onMouseDown={mark(() => editor.chain().focus().toggleBulletList().run())}><List size={15} /></button>
        <button type="button" title="Numbered list" className={state.ordered ? BTN_ACTIVE : BTN}
          onMouseDown={mark(() => editor.chain().focus().toggleOrderedList().run())}><ListOrdered size={15} /></button>
        {SEP}
        {([1, 2, 3] as const).map((l) => (
          <button key={l} type="button"
            onMouseDown={mark(() => editor.chain().focus().toggleHeading({ level: l }).run())}
            className={`px-2 py-1 rounded text-sm font-bold transition-colors ${state.heading === l ? "bg-[#0D6E6E] text-white" : "text-gray-600 hover:bg-gray-200"}`}>
            H{l}
          </button>
        ))}
        {SEP}
        <InsertTableMenu editor={editor} />
        <button type="button" title="Insert picture (you can also paste a screenshot or drop a file)"
          className={BTN} onMouseDown={(e) => { e.preventDefault(); fileInput.current?.click(); }}>
          <ImagePlus size={15} />
        </button>
        <input ref={fileInput} type="file" multiple hidden accept="image/png,image/jpeg,image/gif,image/webp"
          onChange={(e) => {
            const files = pictureFiles(e.target.files);
            e.target.value = "";
            if (files.length) { editor.commands.focus(); void insertImageFiles(editor.view, files); }
          }} />
      </div>
      {state.inTable && <TableControls editor={editor} />}
      {state.onImage && <ImageControls editor={editor} />}
    </div>
  );
}

export function RichTextEditor({ content, onChange, editable = true }: {
  content: string;
  onChange?: (html: string) => void;
  editable?: boolean;
}) {
  const editor = useRichTextEditor({ content, onChange, editable });
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <RichTextToolbar editor={editor} />
      <EditorContent editor={editor} className="min-h-[400px]" />
      {editor && (
        <div className="px-5 py-2 border-t border-gray-100 text-xs text-gray-400 text-right">
          Words: {editor.getText().split(/\s+/).filter(Boolean).length}
        </div>
      )}
    </div>
  );
}
