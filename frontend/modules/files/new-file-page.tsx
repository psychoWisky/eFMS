"use client";
import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { toast } from "sonner";
import { EditorContent } from "@tiptap/react";
import { Loader2, Upload, X, FileText, Send, AlertTriangle, CheckCircle2 } from "lucide-react";
import { PersonBadge } from "@/components/shared/person-badge";
import { SearchableSelect } from "@/components/shared/searchable-select";
import { useRichTextEditor, RichTextToolbar } from "@/components/shared/rich-text-editor";

interface DropItem { id: string; name: string; label?: string; is_active?: boolean; }
interface Establishment { id: string; name: string; }
interface DeptItem { id: string; name: string; establishment_id: string | null; }
interface SystemUser { id: string; full_name: string; designation: string | null; active_role: string | null; department_name?: string | null; employee_code?: string | null; }
interface Annexure { file: File; name: string; tag: string; }

interface NewFileFormProps { onSuccess?: () => void; }

export function NewFilePage() { return <NewFileForm />; }

const DRAFT_KEY = "efms-new-file-draft";

export function NewFileForm({ onSuccess }: NewFileFormProps) {
  const qc = useQueryClient();
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState("");
  const [priority, setPriority] = useState("");
  // Confidentiality is derived solely from Priority — Secret/Confidential is the
  // only priority that implies is_confidential=true; there is no separate toggle.
  const isConfidential = priority.toLowerCase() === "secret";
  const [recipientId, setRecipientId] = useState("");
  const [officeId, setOfficeId] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [draftRestored, setDraftRestored] = useState(false);
  const autoSaveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [annexures, setAnnexures] = useState<Annexure[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const { data: categories = [] } = useQuery<DropItem[]>({ queryKey: ["admin-categories"], queryFn: async () => (await api.get("/admin/categories")).data });
  const { data: priorities = [] } = useQuery<DropItem[]>({ queryKey: ["admin-priorities"], queryFn: async () => (await api.get("/admin/priorities")).data });

  // Office / Section: reuse the existing Establishment/Department APIs — same
  // cascading pattern already used elsewhere in the app. Both are optional
  // filters on the recipient list below, never required to pick a recipient.
  const { data: offices = [] } = useQuery<Establishment[]>({
    queryKey: ["establishments"],
    queryFn: async () => (await api.get("/admin/establishments")).data,
  });
  const { data: sections = [] } = useQuery<DeptItem[]>({
    queryKey: ["departments", officeId],
    queryFn: async () => (await api.get(`/admin/departments?establishment_id=${officeId}`)).data,
    enabled: !!officeId,
  });

  // Recipient list — /admin/users extended with optional establishment_id/
  // department_id filters; omitting both (the default) returns every active
  // user exactly as before, so this is backward compatible with every other
  // consumer of this endpoint.
  const { data: allUsers = [], isFetching: loadingUsers } = useQuery<SystemUser[]>({
    queryKey: ["admin-users", officeId, sectionId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (officeId) params.set("establishment_id", officeId);
      if (sectionId) params.set("department_id", sectionId);
      return (await api.get(`/admin/users?${params.toString()}`)).data;
    },
  });

  const activeCategories = categories.filter((c) => c.is_active !== false);
  const activePriorities = priorities.filter((p) => p.is_active !== false);

  // If the currently selected recipient falls outside the active filter
  // (Office/Section changed, or the recipient was otherwise excluded), clear
  // it rather than silently keeping a hidden, filtered-out selection. Wait
  // for the filtered list to finish loading first, so an in-flight refetch
  // doesn't transiently clear a still-valid selection.
  useEffect(() => {
    if (!loadingUsers && recipientId && !allUsers.some((u) => u.id === recipientId)) {
      setRecipientId("");
    }
  }, [allUsers, loadingUsers, recipientId]);

  // Tiptap WYSIWYG editor (shared config — see components/shared/rich-text-editor.tsx)
  const editor = useRichTextEditor({ content: "<p>Write your official notesheet here…</p>" });

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
        is_confidential: isConfidential,
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
                const isSecret = p.name.toLowerCase() === "secret";
                const isSelected = priority === p.name;
                return (
                  <button key={p.id} type="button" onClick={() => setPriority(p.name)}
                    className={`flex-1 py-2.5 px-2 rounded-xl text-sm font-semibold border-2 transition-all capitalize ${
                      isSelected
                        ? isUrgent ? "border-red-600 bg-red-600 text-white"
                          : isSecret ? "border-purple-700 bg-purple-700 text-white"
                          : "border-[#0D6E6E] bg-[#0D6E6E] text-white"
                        : "border-gray-200 text-gray-600 hover:border-[#0D6E6E] hover:text-[#0D6E6E]"
                    }`}>
                    {p.label ?? p.name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {isConfidential && (
          <p className="mt-4 text-sm text-purple-700 bg-purple-50 border border-purple-200 rounded-xl px-4 py-2.5">
            Secret/Confidential priority restricts this file's movement to only the original sender and recipient.
          </p>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mt-5">
          <div>
            <label className="block text-base font-semibold text-gray-700 mb-2">Office</label>
            <p className="text-sm text-gray-400 mb-2">Optional — narrows the recipient list below.</p>
            <SearchableSelect
              options={offices.map((o) => ({ value: o.id, label: o.name }))}
              value={officeId}
              onChange={(v) => { setOfficeId(v); setSectionId(""); }}
              placeholder="All offices…"
              searchPlaceholder="Search offices…"
            />
          </div>
          <div>
            <label className="block text-base font-semibold text-gray-700 mb-2">Section</label>
            <p className="text-sm text-gray-400 mb-2">Optional — requires an Office first.</p>
            <SearchableSelect
              options={sections.map((s) => ({ value: s.id, label: s.name }))}
              value={sectionId}
              onChange={setSectionId}
              placeholder={officeId ? "All sections…" : "Select an Office first"}
              searchPlaceholder="Search sections…"
              disabled={!officeId}
            />
          </div>
          <div>
            <label className="block text-base font-semibold text-gray-700 mb-2">Recipient (optional)</label>
            <p className="text-sm text-gray-400 mb-2">The file is saved as a Draft. You can choose a recipient now or leave it for later — Forward is what actually sends it.</p>
            {!loadingUsers && allUsers.length === 0 ? (
              <p className="text-sm text-amber-600 bg-amber-50 rounded-xl p-3">No users found for this filter.</p>
            ) : (
              <SearchableSelect
                options={allUsers.map((u) => ({
                  value: u.id,
                  label: u.employee_code ? `${u.full_name} (${u.employee_code})` : u.full_name,
                }))}
                value={recipientId}
                onChange={setRecipientId}
                placeholder="No recipient yet…"
                searchPlaceholder="Search by name or employee code…"
                disabled={loadingUsers}
              />
            )}
            {selectedRecipient && (
              <p className="text-sm text-[#0D6E6E] mt-1.5 flex items-center gap-2">
                <CheckCircle2 size={13} className="shrink-0" /> Intended recipient: <PersonBadge person={selectedRecipient} compact />
              </p>
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

        <RichTextToolbar editor={editor} />
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
              <div><h3 className="text-xl font-bold text-gray-900">Confirm Draft</h3><p className="text-base text-gray-500">This saves a Draft — it is not sent to anyone yet. Use Forward afterwards to send it.</p></div>
            </div>
            <div className="bg-gray-50 rounded-xl p-4 space-y-2 mb-6 text-base">
              <div><span className="font-semibold text-gray-600">Subject:</span> <span>{subject}</span></div>
              <div><span className="font-semibold text-gray-600">Category:</span> <span>{category}</span></div>
              <div><span className="font-semibold text-gray-600">Priority:</span> <span className="capitalize">{priority}</span></div>
              {isConfidential && <div><span className="font-semibold text-gray-600">Confidential:</span> <span className="text-purple-700 font-semibold">Yes — restricted to sender and recipient only</span></div>}
              <div className="flex items-start gap-2"><span className="font-semibold text-gray-600 shrink-0">Intended recipient:</span> {selectedRecipient ? <PersonBadge person={selectedRecipient} compact /> : <span>Not chosen yet</span>}</div>
              {annexures.length > 0 && <div><span className="font-semibold text-gray-600">Annexures:</span> <span>{annexures.map((a) => a.tag).join(", ")}</span></div>}
            </div>
            <div className="flex gap-3">
              <button type="button" onClick={() => setConfirm(false)} className="flex-1 px-5 py-3 text-base border border-gray-200 rounded-xl hover:bg-gray-50 font-medium">Edit</button>
              <button type="button" onClick={() => createFile.mutate()} disabled={createFile.isPending}
                className="flex-1 px-5 py-3 text-base bg-[#0D6E6E] text-white rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-[#178F8F] disabled:opacity-50">
                {createFile.isPending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                {createFile.isPending ? "Saving…" : "Save Draft"}
              </button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
