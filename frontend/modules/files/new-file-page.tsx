"use client";
import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { toast } from "sonner";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { Loader2, Upload, X, FileText, Send, AlertTriangle, CheckCircle2, Bold, Italic, Underline as UIcon, AlignLeft, AlignCenter, AlignRight, List, ListOrdered, Grid2x2 } from "lucide-react";

interface DropItem { id: string; name: string; label?: string; is_active?: boolean; }
interface SystemUser { id: string; full_name: string; designation: string | null; active_role: string | null; }
interface Annexure { file: File; name: string; tag: string; }

interface NewFileFormProps { onSuccess?: () => void; }

export function NewFilePage() { return <NewFileForm />; }

const DRAFT_KEY = "efms-new-file-draft";

export function NewFileForm({ onSuccess }: NewFileFormProps) {
  const qc = useQueryClient();
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState("");
  const [priority, setPriority] = useState("");
  const [recipientId, setRecipientId] = useState("");
  const [draftRestored, setDraftRestored] = useState(false);
  const autoSaveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [annexures, setAnnexures] = useState<Annexure[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const { data: categories = [] } = useQuery<DropItem[]>({ queryKey: ["admin-categories"], queryFn: async () => (await api.get("/admin/categories")).data });
  const { data: priorities = [] } = useQuery<DropItem[]>({ queryKey: ["admin-priorities"], queryFn: async () => (await api.get("/admin/priorities")).data });
  const { data: allUsers = [] } = useQuery<SystemUser[]>({ queryKey: ["admin-users"], queryFn: async () => (await api.get("/admin/users")).data });

  const activeCategories = categories.filter((c) => c.is_active !== false);
  const activePriorities = priorities.filter((p) => p.is_active !== false);

  // Tiptap WYSIWYG editor
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
    content: "<p>Write your official notesheet here…</p>",
    editorProps: {
      attributes: { class: "prose max-w-none focus:outline-none min-h-[400px] p-5 text-base leading-relaxed" },
      transformPastedHTML(html) {
        // Remove MS Word / LibreOffice proprietary tags and attributes
        // while keeping structural HTML (headings, bold, italic, lists, tables)
        return html
          // Strip Word XML namespaced tags entirely
          .replace(/<\/?o:[^>]*>/gi, "")
          .replace(/<\/?w:[^>]*>/gi, "")
          .replace(/<\/?m:[^>]*>/gi, "")
          .replace(/<\/?v:[^>]*>/gi, "")
          // Remove Word conditional comments
          .replace(/<!--\[if[^>]*>[\s\S]*?<!\[endif\]-->/gi, "")
          // Strip class attributes (Word class names like MsoNormal, MsoBodyText)
          .replace(/\s*class="[^"]*Mso[^"]*"/gi, "")
          .replace(/\s*class="[^"]*"/gi, "")
          // Strip Word-specific style properties but keep inline bold/italic signals
          .replace(/\s*style="[^"]*mso-[^"]*"/gi, "")
          .replace(/\s*style="[^"]*font-family:[^"]*"/gi, "")
          .replace(/\s*style="[^"]*font-size:[^"]*"/gi, "")
          // Remove empty paragraphs Word inserts (<p>&nbsp;</p>)
          .replace(/<p[^>]*>(\s|&nbsp;)*<\/p>/gi, "")
          // Strip lang attributes
          .replace(/\s*lang="[^"]*"/gi, "");
      },
    },
  });

  // Restore draft on mount
  useEffect(() => {
    const saved = localStorage.getItem(DRAFT_KEY);
    if (saved && editor) {
      try {
        const { content, subject: s, category: c, priority: p } = JSON.parse(saved);
        if (content) { editor.commands.setContent(content); setDraftRestored(true); }
        if (s) setSubject(s);
        if (c) setCategory(c);
        if (p) setPriority(p);
      } catch { /* ignore */ }
    }
  }, [editor]);

  // Auto-save every 30s
  useEffect(() => {
    autoSaveRef.current = setInterval(() => {
      if (editor) {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          content: editor.getHTML(), subject, category, priority,
        }));
      }
    }, 30_000);
    return () => { if (autoSaveRef.current) clearInterval(autoSaveRef.current); };
  }, [editor, subject, category, priority]);

  const createFile = useMutation({
    mutationFn: async () => {
      const noteContent = editor?.getHTML() ?? "";
      const selectedUser = allUsers.find((u) => u.id === recipientId);
      const res = await api.post("/efms/files", {
        subject,
        category,
        priority,
        recipient_id: recipientId || undefined,
        recipient_name: selectedUser?.full_name,
        initial_content: noteContent,
      });
      const fileId = res.data.id;

      // Upload each annexure
      for (let i = 0; i < annexures.length; i++) {
        const ann = annexures[i];
        const form = new FormData();
        form.append("upload", ann.file, `${ann.tag}-${ann.name || ann.file.name}`);
        await api.post(`/efms/files/${fileId}/attachments`, form, {
          headers: { "Content-Type": "multipart/form-data" },
        }).catch(() => {});
      }
      return res.data;
    },
    onSuccess: () => {
      toast.success("File created and submitted successfully.");
      qc.invalidateQueries({ queryKey: ["efms-files"] });
      qc.invalidateQueries({ queryKey: ["efms-files-outbox"] });
      onSuccess?.();
      // Reset form
      setSubject(""); setCategory(""); setPriority(""); setRecipientId(""); setAnnexures([]); setDraftRestored(false);
      localStorage.removeItem(DRAFT_KEY);
      editor?.commands.clearContent();
      setConfirm(false);
    },
    onError: (err: unknown) => {
      const data = (err as { response?: { data?: { detail?: string; message?: string; errors?: { field: string; message: string }[] } } })?.response?.data;
      const msg = data?.detail ?? data?.message;
      const fieldErrors = data?.errors?.map((e) => `${e.field}: ${e.message}`).join("; ");
      toast.error(fieldErrors ?? msg ?? "Failed to create file.");
      setConfirm(false);
    },
  });

  function addAnnexure(files: FileList | null) {
    if (!files) return;
    const next = [...annexures];
    Array.from(files).forEach((f, i) => {
      const idx = next.length + i + 1;
      next.push({ file: f, name: f.name, tag: `doc-${idx}` });
    });
    setAnnexures(next.slice(0, 10));
  }

  function removeAnnexure(i: number) { setAnnexures((a) => a.filter((_, idx) => idx !== i)); }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault(); setIsDragging(false);
    addAnnexure(e.dataTransfer.files);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!subject.trim()) { toast.error("Subject is required."); return; }
    if (subject.trim().length < 5) { toast.error("Subject must be at least 5 characters."); return; }
    if (!category) { toast.error("Category is required."); return; }
    if (!priority) { toast.error("Priority is required."); return; }
    if (!recipientId) { toast.error("Please select a recipient."); return; }
    setConfirm(true);
  }

  const selectedRecipient = allUsers.find((u) => u.id === recipientId);

  return (
    <form onSubmit={handleSubmit} className="space-y-5 max-w-none">
      {draftRestored && (
        <div className="flex items-center justify-between px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-sm">
          <span>Draft restored from your last session.</span>
          <button type="button" onClick={() => { localStorage.removeItem(DRAFT_KEY); editor?.commands.clearContent(); setSubject(""); setCategory(""); setPriority(""); setDraftRestored(false); }}
            className="ml-4 text-xs font-semibold underline hover:no-underline">Clear draft</button>
        </div>
      )}
      {/* Row 1: Subject (2 cols) + Category + Priority + Recipient */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
        <h3 className="text-lg font-bold text-gray-800 mb-5">File Details</h3>
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
          <div className="lg:col-span-2">
            <label className="block text-base font-semibold text-gray-700 mb-2">Subject *</label>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Describe the purpose of this file…"
              className="w-full border border-gray-300 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]" />
          </div>
          <div>
            <label className="block text-base font-semibold text-gray-700 mb-2">Category *</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)}
              className="w-full border border-gray-300 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]">
              <option value="">Select…</option>
              {activeCategories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-base font-semibold text-gray-700 mb-2">Priority *</label>
            <div className="flex gap-2">
              {activePriorities.map((p) => {
                const isUrgent = p.name.toLowerCase() === "urgent";
                const isSelected = priority === p.name;
                return (
                  <button key={p.id} type="button" onClick={() => setPriority(p.name)}
                    className={`flex-1 py-2.5 px-2 rounded-xl text-sm font-semibold border-2 transition-all capitalize ${
                      isSelected
                        ? isUrgent ? "border-red-600 bg-red-600 text-white" : "border-[#0D6E6E] bg-[#0D6E6E] text-white"
                        : "border-gray-200 text-gray-600 hover:border-[#0D6E6E] hover:text-[#0D6E6E]"
                    }`}>
                    {p.label ?? p.name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mt-5">
          <div>
            <label className="block text-base font-semibold text-gray-700 mb-2">Forward To (Recipient) *</label>
            {allUsers.length === 0 ? (
              <p className="text-sm text-amber-600 bg-amber-50 rounded-xl p-3">No users available. Check that users have been approved.</p>
            ) : (
              <select value={recipientId} onChange={(e) => setRecipientId(e.target.value)}
                className="w-full border border-gray-300 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]">
                <option value="">Select recipient…</option>
                {allUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.designation ? `${u.designation} — ` : ""}{u.full_name}
                  </option>
                ))}
              </select>
            )}
            {selectedRecipient && (
              <p className="text-sm text-[#0D6E6E] mt-1.5 flex items-center gap-1"><CheckCircle2 size={13} /> Will be forwarded to: {selectedRecipient.full_name}</p>
            )}
          </div>
        </div>
      </div>

      {/* Row 2: Annexure Uploads (BEFORE notesheet) */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
        <h3 className="text-lg font-bold text-gray-800 mb-2">Attachments / Annexures</h3>
        <p className="text-sm text-gray-500 mb-4">Upload supporting documents first. Name and tag each file as Annexure 1, 2, etc. All files will be available as PDF to recipients.</p>
        <div onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }} onDragLeave={() => setIsDragging(false)} onDrop={handleDrop}
          className={`border-2 border-dashed rounded-xl p-6 text-center transition-colors mb-4 ${isDragging ? "border-[#0D6E6E] bg-[#E6F4F4]" : "border-gray-200 hover:border-gray-300"}`}>
          <Upload className="w-8 h-8 mx-auto mb-2 text-gray-300" />
          <p className="text-base text-gray-500">Drag files here or <label className="text-[#0D6E6E] cursor-pointer hover:underline font-medium">browse<input type="file" multiple className="sr-only" onChange={(e) => addAnnexure(e.target.files)} /></label></p>
          <p className="text-sm text-gray-400 mt-1">PDF, DOC, DOCX, JPG, PNG · Max 10 MB each · Up to 10 files</p>
        </div>
        {annexures.length > 0 && (
          <div className="space-y-2">
            {annexures.map((ann, i) => (
              <div key={i} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100">
                <FileText className="w-5 h-5 text-[#0D6E6E] shrink-0" />
                <div className="flex-1 grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">File Name</label>
                    <input value={ann.name} onChange={(e) => setAnnexures((a) => a.map((x, idx) => idx === i ? { ...x, name: e.target.value } : x))}
                      className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#0D6E6E]" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Tag</label>
                    <select value={ann.tag} onChange={(e) => setAnnexures((a) => a.map((x, idx) => idx === i ? { ...x, tag: e.target.value } : x))}
                      className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#0D6E6E]">
                      {[
                        ...Array.from({ length: 10 }, (_, k) => `doc-${k + 1}`),
                        "Annexure 1","Annexure 2","Annexure 3","Annexure 4","Annexure 5",
                        "Annexure A","Annexure B","Annexure C",
                        "Supporting Document","Reference Document",
                        "Enclosure 1","Enclosure 2","Enclosure 3",
                        "Exhibit 1","Exhibit 2",
                        "Proof of Identity","Proof of Address","Certificate","Other",
                      ].map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <span className="text-sm text-gray-400 shrink-0">{(ann.file.size / 1024).toFixed(0)} KB</span>
                <button type="button" onClick={() => removeAnnexure(i)} className="text-red-400 hover:text-red-600 shrink-0"><X size={16} /></button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Row 3: WYSIWYG Notesheet */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-bold text-gray-800">Official Notesheet *</h3>
          <p className="text-sm text-gray-400">Paste from Word/PDF — formatting is preserved</p>
        </div>

        {/* Tiptap Toolbar */}
        {editor && (
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
            {["H1","H2","H3"].map((h, i) => (
              <button key={h} type="button" onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleHeading({ level: (i+1) as 1|2|3 }).run(); }}
                className={`px-2 py-1 rounded text-sm font-bold transition-colors ${editor.isActive("heading",{level:i+1}) ? "bg-[#0D6E6E] text-white" : "text-gray-600 hover:bg-gray-200"}`}>
                {h}
              </button>
            ))}
            <div className="w-px bg-gray-200 mx-1" />
            <button type="button" title="Insert Table"
              onMouseDown={(e) => { e.preventDefault(); editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); }}
              className="p-2 rounded-lg text-gray-600 hover:bg-gray-200">
              <Grid2x2 size={15} />
            </button>
          </div>
        )}
        <EditorContent editor={editor} className="min-h-[400px]" />
        {editor && (
          <div className="px-5 py-2 border-t border-gray-100 text-xs text-gray-400 text-right">
            Words: {editor.getText().split(/\s+/).filter(Boolean).length}
          </div>
        )}
      </div>

      {/* Submit */}
      <div className="flex justify-end gap-3 pb-4">
        <button type="submit" className="flex items-center gap-2 px-8 py-3.5 bg-[#0D6E6E] text-white text-base font-bold rounded-xl hover:bg-[#178F8F]">
          <Send size={18} /> Review & Submit
        </button>
      </div>

      {/* Confirm dialog */}
      {confirm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6">
          <div className="bg-white rounded-2xl p-8 max-w-lg w-full shadow-2xl">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-12 h-12 rounded-xl bg-[#E6F4F4] flex items-center justify-center">
                <AlertTriangle className="w-6 h-6 text-[#0D6E6E]" />
              </div>
              <div><h3 className="text-xl font-bold text-gray-900">Confirm Submission</h3><p className="text-base text-gray-500">Please review before sending</p></div>
            </div>
            <div className="bg-gray-50 rounded-xl p-4 space-y-2 mb-6 text-base">
              <div><span className="font-semibold text-gray-600">Subject:</span> <span>{subject}</span></div>
              <div><span className="font-semibold text-gray-600">Category:</span> <span>{category}</span></div>
              <div><span className="font-semibold text-gray-600">Priority:</span> <span className="capitalize">{priority}</span></div>
              <div><span className="font-semibold text-gray-600">Recipient:</span> <span>{selectedRecipient?.full_name}</span></div>
              {annexures.length > 0 && <div><span className="font-semibold text-gray-600">Annexures:</span> <span>{annexures.map((a) => a.tag).join(", ")}</span></div>}
            </div>
            <div className="flex gap-3">
              <button type="button" onClick={() => setConfirm(false)} className="flex-1 px-5 py-3 text-base border border-gray-200 rounded-xl hover:bg-gray-50 font-medium">Edit</button>
              <button type="button" onClick={() => createFile.mutate()} disabled={createFile.isPending}
                className="flex-1 px-5 py-3 text-base bg-[#0D6E6E] text-white rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-[#178F8F] disabled:opacity-50">
                {createFile.isPending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                {createFile.isPending ? "Submitting…" : "Confirm & Send"}
              </button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
