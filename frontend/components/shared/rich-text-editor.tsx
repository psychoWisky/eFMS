"use client";
// Shared Tiptap WYSIWYG editor — the notesheet-authoring component reused by
// both New File creation and Draft editing, so the extension set, paste
// cleanup, and toolbar are defined in exactly one place.
import { useEffect } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { Bold, Italic, Underline as UIcon, AlignLeft, AlignCenter, AlignRight, List, ListOrdered, Grid2x2 } from "lucide-react";

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
    .replace(/<p[^>]*>(\s|&nbsp;)*<\/p>/gi, "")
    .replace(/\s*lang="[^"]*"/gi, "");
}

export function useRichTextEditor({ content, onChange, editable = true }: {
  content: string;
  onChange?: (html: string) => void;
  editable?: boolean;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Highlight,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Table.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
    ],
    content,
    editable,
    editorProps: {
      attributes: { class: "prose max-w-none focus:outline-none min-h-[400px] p-5 text-base leading-relaxed" },
      transformPastedHTML,
    },
    onUpdate: ({ editor }) => onChange?.(editor.getHTML()),
  });

  useEffect(() => {
    if (editor) editor.setEditable(editable);
  }, [editor, editable]);

  return editor;
}

export function RichTextToolbar({ editor }: { editor: ReturnType<typeof useRichTextEditor> }) {
  if (!editor) return null;
  return (
    <div className="flex flex-wrap gap-1 px-4 py-2 border-b border-gray-100 bg-gray-50">
      {[
        { icon: Bold, cmd: () => editor.chain().focus().toggleBold().run(), active: editor.isActive("bold") },
        { icon: Italic, cmd: () => editor.chain().focus().toggleItalic().run(), active: editor.isActive("italic") },
        { icon: UIcon, cmd: () => editor.chain().focus().toggleUnderline().run(), active: editor.isActive("underline") },
      ].map(({ icon: Icon, cmd, active }, i) => (
        <button key={i} type="button" onMouseDown={(e) => { e.preventDefault(); cmd(); }}
          className={`p-2 rounded-lg transition-colors ${active ? "bg-[#0D6E6E] text-white" : "text-gray-600 hover:bg-gray-200"}`}>
          <Icon size={15} />
        </button>
      ))}
      <div className="w-px bg-gray-200 mx-1" />
      {[
        { icon: AlignLeft, cmd: () => editor.chain().focus().setTextAlign("left").run() },
        { icon: AlignCenter, cmd: () => editor.chain().focus().setTextAlign("center").run() },
        { icon: AlignRight, cmd: () => editor.chain().focus().setTextAlign("right").run() },
      ].map(({ icon: Icon, cmd }, i) => (
        <button key={i} type="button" onMouseDown={(e) => { e.preventDefault(); cmd(); }}
          className="p-2 rounded-lg text-gray-600 hover:bg-gray-200">
          <Icon size={15} />
        </button>
      ))}
      <div className="w-px bg-gray-200 mx-1" />
      {[
        { icon: List, cmd: () => editor.chain().focus().toggleBulletList().run() },
        { icon: ListOrdered, cmd: () => editor.chain().focus().toggleOrderedList().run() },
      ].map(({ icon: Icon, cmd }, i) => (
        <button key={i} type="button" onMouseDown={(e) => { e.preventDefault(); cmd(); }}
          className="p-2 rounded-lg text-gray-600 hover:bg-gray-200">
          <Icon size={15} />
        </button>
      ))}
      <div className="w-px bg-gray-200 mx-1" />
      {["H1", "H2", "H3"].map((h, i) => (
        <button key={h} type="button" onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleHeading({ level: (i + 1) as 1 | 2 | 3 }).run(); }}
          className={`px-2 py-1 rounded text-sm font-bold transition-colors ${editor.isActive("heading", { level: i + 1 }) ? "bg-[#0D6E6E] text-white" : "text-gray-600 hover:bg-gray-200"}`}>
          {h}
        </button>
      ))}
      <div className="w-px bg-gray-200 mx-1" />
      <button type="button" title="Insert Table"
        onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); }}
        className="p-2 rounded-lg text-gray-600 hover:bg-gray-200">
        <Grid2x2 size={15} />
      </button>
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
