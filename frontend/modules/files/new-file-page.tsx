"use client";
import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { toast } from "sonner";
import { showSuccess } from "@/lib/alert";
import { isNotesheetEmpty } from "@/lib/utils";
import { EditorContent } from "@tiptap/react";
import { Loader2, Upload, X, FileText, Send, AlertTriangle, CheckCircle2, Save, Paperclip, UserCheck } from "lucide-react";
import { PersonBadge } from "@/components/shared/person-badge";
import { SearchableSelect } from "@/components/shared/searchable-select";
import { useRichTextEditor, RichTextToolbar } from "@/components/shared/rich-text-editor";
import { useFavoriteRecipients } from "@/hooks/use-favorite-recipients";
import { useRecipientFilter } from "@/hooks/use-recipient-filter";
import { useAttachmentQueue, resolveAttachmentTag } from "@/hooks/use-attachment-queue";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";
import {
  ATTACHMENT_TAGS, CUSTOM_TAG_VALUE, ALLOWED_ATTACHMENT_ACCEPT, ALLOWED_ATTACHMENT_HELP_TEXT, validateCustomTag,
} from "@/lib/attachment-constants";

interface DropItem { id: string; name: string; label?: string; is_active?: boolean; }

interface NewFileFormProps { onSuccess?: () => void; }

export function NewFilePage() { return <NewFileForm />; }

const DRAFT_KEY = "efms-new-file-draft";
const DEFAULT_NOTESHEET_HTML = "<p>Write your official notesheet here…</p>";

export function NewFileForm({ onSuccess }: NewFileFormProps) {
  const qc = useQueryClient();
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState("");
  const [priority, setPriority] = useState("");
  // Confidentiality is derived solely from Priority — Secret/Confidential is the
  // only priority that implies is_confidential=true; there is no separate toggle.
  const isConfidential = priority.toLowerCase() === "secret";
  const [recipientId, setRecipientId] = useState("");
  const [draftRestored, setDraftRestored] = useState(false);
  const autoSaveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const attachmentQueue = useAttachmentQueue();
  const { items: annexures } = attachmentQueue;
  const [confirm, setConfirm] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const { toggleFavorite, buildGroups, personLabel } = useFavoriteRecipients();

  // Office / Section -> Recipient cascade — shared with Edit Draft/Forward on
  // an existing file (useRecipientFilter) so every recipient picker in the
  // app filters identically instead of each screen re-implementing this.
  const { officeId, setOfficeId, sectionId, setSectionId, offices, sections, users: allUsers, loadingUsers } = useRecipientFilter();

  const { data: categories = [] } = useQuery<DropItem[]>({ queryKey: ["admin-categories"], queryFn: async () => (await api.get("/admin/categories")).data });
  const { data: priorities = [] } = useQuery<DropItem[]>({ queryKey: ["admin-priorities"], queryFn: async () => (await api.get("/admin/priorities")).data });

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

  // Tracks whether the notesheet body differs from its default placeholder —
  // driven by the editor's onChange rather than reading getHTML() at render
  // time, since Tiptap doesn't re-render its parent on every keystroke on
  // its own. Also flips true when a draft is restored from localStorage:
  // that autosave is not a real save, so restored content must still count
  // as unsaved until the user explicitly saves it.
  const [notesheetDirty, setNotesheetDirty] = useState(false);

  // Tiptap WYSIWYG editor (shared config — see components/shared/rich-text-editor.tsx)
  const editor = useRichTextEditor({
    content: DEFAULT_NOTESHEET_HTML,
    onChange: (html) => setNotesheetDirty(html !== DEFAULT_NOTESHEET_HTML),
  });

  // Restore draft on mount
  useEffect(() => {
    const saved = localStorage.getItem(DRAFT_KEY);
    if (saved && editor) {
      try {
        const { content, subject: s, category: c, priority: p } = JSON.parse(saved);
        if (content) { editor.commands.setContent(content); setDraftRestored(true); setNotesheetDirty(content !== DEFAULT_NOTESHEET_HTML); }
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

  // Shared by both "Save Draft" and "Forward" — creates the file and
  // uploads any queued attachments, returning the new file's id. Forward
  // (createAndForwardFile below) does the create step identically, then
  // makes one additional call to the SAME existing POST /{id}/route
  // endpoint the file page's own Forward button already uses — no second,
  // parallel forwarding implementation.
  async function doCreateFile(): Promise<string> {
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
    // Reporting variant: the file already exists at this point and isn't
    // safely re-creatable, so an attachment failure here must not block
    // navigation the way a genuinely-retryable save would — it's reported
    // to the user instead of silently swallowed (unlike the ordinary
    // uploadAll used nowhere else in this flow anymore).
    const { failed } = await attachmentQueue.uploadAllReporting(fileId);
    if (failed.length > 0) {
      toast.error(
        `File saved, but ${failed.length} attachment${failed.length > 1 ? "s" : ""} failed to upload: ${failed.map((f) => f.name).join(", ")}. You can add them again from the file page.`
      );
    }
    return fileId;
  }

  function resetFormAfterSuccess() {
    setSubject(""); setCategory(""); setPriority(""); setRecipientId(""); attachmentQueue.clear(); setDraftRestored(false);
    localStorage.removeItem(DRAFT_KEY);
    editor?.commands.setContent(DEFAULT_NOTESHEET_HTML);
    setNotesheetDirty(false);
    setConfirm(false);
  }

  function handleCreateError(err: unknown) {
    const data = (err as { response?: { data?: { detail?: string; message?: string; errors?: { field: string; message: string }[] } } })?.response?.data;
    const msg = data?.detail ?? data?.message;
    const fieldErrors = data?.errors?.map((e) => `${e.field}: ${e.message}`).join("; ");
    toast.error(fieldErrors ?? msg ?? "Failed to save file.");
    setConfirm(false);
  }

  const createFile = useMutation({
    mutationFn: doCreateFile,
    onSuccess: () => {
      showSuccess("File created and submitted successfully.");
      qc.invalidateQueries({ queryKey: ["efms-files"] });
      qc.invalidateQueries({ queryKey: ["efms-files-outbox"] });
      onSuccess?.();
      resetFormAfterSuccess();
    },
    onError: handleCreateError,
  });

  // Direct Forward: create the file, then immediately forward it to the
  // chosen recipient via the existing POST /{id}/route endpoint (action:
  // "forward") — the exact same routing/notesheet/holder-transfer logic
  // the file page's own Forward button triggers, reused as-is rather than
  // reimplemented. The backend independently re-validates the notesheet
  // isn't empty and that the recipient isn't a Super Admin on that call —
  // this mutation doesn't duplicate either check, it just surfaces
  // whatever the backend rejects.
  const createAndForwardFile = useMutation({
    mutationFn: async () => {
      const fileId = await doCreateFile();
      await api.post(`/efms/files/${fileId}/route`, { action: "forward", to_user_id: recipientId });
      return fileId;
    },
    onSuccess: () => {
      showSuccess("File created and forwarded successfully.");
      qc.invalidateQueries({ queryKey: ["efms-files"] });
      qc.invalidateQueries({ queryKey: ["efms-files-outbox"] });
      qc.invalidateQueries({ queryKey: ["my-docket"] });
      onSuccess?.();
      resetFormAfterSuccess();
    },
    onError: handleCreateError,
  });

  function handleDrop(e: React.DragEvent) {
    e.preventDefault(); setIsDragging(false);
    attachmentQueue.addFiles(e.dataTransfer.files);
  }

  function validateForm(): string | null {
    if (!subject.trim()) return "Subject is required.";
    if (subject.trim().length < 5) return "Subject must be at least 5 characters.";
    if (!category) return "Category is required.";
    if (!priority) return "Priority is required.";
    if (attachmentQueue.hasInvalidCustomTags()) return "Please enter a valid custom tag for every attachment marked \"Other\".";
    return null;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const err = validateForm();
    if (err) { toast.error(err); return; }
    setConfirm(true);
  }

  // Real unsaved-changes tracking — never hardcoded true on mount. Covers
  // every field the task requires (Subject/Category/Priority/Recipient/
  // Notesheet/queued attachments); localStorage's own autosave is not a
  // substitute since it never actually persists the file to the backend.
  const isDirty =
    subject.trim() !== "" || category !== "" || priority !== "" || recipientId !== "" ||
    annexures.length > 0 || notesheetDirty;

  function handleDiscardNewFile() {
    setSubject(""); setCategory(""); setPriority(""); setRecipientId("");
    attachmentQueue.clear();
    setDraftRestored(false);
    setNotesheetDirty(false);
    localStorage.removeItem(DRAFT_KEY);
    editor?.commands.setContent(DEFAULT_NOTESHEET_HTML);
  }

  // The explicit "Save Changes" button's own handler — validates, then saves
  // via the same create/save-draft mutation "Review & Submit" -> "Save
  // Draft" already uses, just without the confirmation-review step. Errors
  // are already surfaced by createFile's own onError toast; nothing here
  // triggers navigation — Save Changes only ever persists, never leaves.
  async function handleSaveChanges() {
    const err = validateForm();
    if (err) { toast.error(err); return; }
    try {
      await createFile.mutateAsync();
    } catch {
      // createFile's own onError already surfaced a toast.
    }
  }

  // The navigation guard's ONLY job is "if dirty, ask Leave/Stay" — it never
  // saves. Persisting only ever happens via the explicit Save Changes button
  // (or the existing Review & Submit -> Save Draft flow) above.
  useUnsavedChangesGuard({
    isDirty,
    onDiscard: handleDiscardNewFile,
  });

  const selectedRecipient = allUsers.find((u) => u.id === recipientId);

  const fieldLabel = "block text-sm font-semibold text-gray-700 mb-1.5";
  const fieldHint = "text-xs text-gray-400 mb-1.5";
  const textInput = "w-full border border-gray-300 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]";
  const cardCls = "bg-white rounded-2xl border border-gray-200 shadow-sm";

  return (
    <form onSubmit={handleSubmit} className="w-full space-y-4">
      {draftRestored && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-sm">
          <span>Draft restored from your last session.</span>
          <button type="button" onClick={() => { localStorage.removeItem(DRAFT_KEY); editor?.commands.setContent(DEFAULT_NOTESHEET_HTML); setNotesheetDirty(false); setSubject(""); setCategory(""); setPriority(""); setDraftRestored(false); }}
            className="text-xs font-semibold underline hover:no-underline shrink-0">Clear draft</button>
        </div>
      )}

      {/* ── TOP: form fields (left) + attachments (right) ── */}
      <div className="flex flex-col lg:flex-row gap-4 items-start">
        <div className="flex-1 min-w-0 w-full space-y-4">
        {/* ── File Details ── */}
        <section className={`${cardCls} p-5`}>
          <h3 className="text-base font-bold text-gray-900">File Details</h3>
          <p className="text-xs text-gray-400 mt-0.5 mb-4">Basic information about the file. All three fields are required.</p>

          <div className="space-y-4">
            <div>
              <label className={fieldLabel}>Subject *</label>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Describe the purpose of this file…"
                className={textInput} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={fieldLabel}>Category *</label>
                <SearchableSelect
                  options={activeCategories.map((c) => ({ value: c.name, label: c.name }))}
                  value={category}
                  onChange={setCategory}
                  clearable={false}
                  placeholder="Select a category…"
                  searchPlaceholder="Search categories…"
                />
              </div>
              <div>
                <label className={fieldLabel}>Priority *</label>
                <div className="grid grid-cols-3 gap-2">
                  {activePriorities.map((p) => {
                    const isUrgent = p.name.toLowerCase() === "urgent";
                    const isSecret = p.name.toLowerCase() === "secret";
                    const isSelected = priority === p.name;
                    return (
                      <button key={p.id} type="button" onClick={() => setPriority(p.name)}
                        className={`w-full py-2.5 px-1 rounded-xl text-xs font-semibold border-2 transition-all leading-tight ${
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
              <p className="text-sm text-purple-700 bg-purple-50 border border-purple-200 rounded-xl px-3.5 py-2.5">
                Secret / Confidential priority restricts this file&apos;s movement to only the original sender and recipient.
              </p>
            )}
          </div>
        </section>

        {/* ── Select Recipient ── */}
        <section className={`${cardCls} p-5`}>
          <h3 className="text-base font-bold text-gray-900 flex items-center gap-2">
            <UserCheck size={17} className="text-[#0D6E6E]" /> Select Recipient
          </h3>
          <p className="text-xs text-gray-400 mt-0.5 mb-4">
            Optional now. Saving only creates a Draft — <span className="font-semibold text-gray-500">Forward</span> is what actually sends the file.
          </p>

          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={fieldLabel}>Office</label>
                <p className={fieldHint}>Narrows the recipient list below.</p>
                <SearchableSelect
                  options={offices.map((o) => ({ value: o.id, label: o.name }))}
                  value={officeId}
                  onChange={setOfficeId}
                  placeholder="All offices…"
                  searchPlaceholder="Search offices…"
                />
              </div>
              <div>
                <label className={fieldLabel}>Section</label>
                <p className={fieldHint}>Requires an Office first.</p>
                <SearchableSelect
                  options={sections.map((s) => ({ value: s.id, label: s.name }))}
                  value={sectionId}
                  onChange={setSectionId}
                  placeholder={officeId ? "All sections…" : "Select an Office first"}
                  searchPlaceholder="Search sections…"
                  disabled={!officeId}
                />
              </div>
            </div>

            <div>
              <label className={fieldLabel}>Recipient</label>
              <p className={fieldHint}>Choose a person now, or leave it and pick one when you Forward.</p>
              {!loadingUsers && allUsers.length === 0 ? (
                <p className="text-sm text-amber-600 bg-amber-50 rounded-xl p-3">
                  {officeId || sectionId ? "No users found for this filter." : "No eligible recipients are currently available."}
                </p>
              ) : (
                <SearchableSelect
                  groups={buildGroups(allUsers, personLabel)}
                  value={recipientId}
                  onChange={setRecipientId}
                  isFavorite={(id) => !!allUsers.find((u) => u.id === id)?.is_favorite}
                  onToggleFavorite={(id) => {
                    const u = allUsers.find((u) => u.id === id);
                    if (u) toggleFavorite(id, !!u.is_favorite);
                  }}
                  placeholder="No recipient yet…"
                  searchPlaceholder="Search by name or employee code…"
                  disabled={loadingUsers}
                />
              )}
              {selectedRecipient && (
                <div className="mt-2 flex items-center gap-2 text-sm text-[#0D6E6E] bg-[#E6F4F4] border border-[#0D6E6E]/20 rounded-xl px-3 py-2">
                  <CheckCircle2 size={14} className="shrink-0" />
                  <span className="text-gray-500">Intended recipient:</span>
                  <PersonBadge person={selectedRecipient} compact />
                </div>
              )}
            </div>
          </div>
        </section>
        </div>

        {/* ── Attachments — right column ── */}
        <div className="w-full lg:w-[380px] shrink-0">
          <section className={`${cardCls} p-5`}>
            <h3 className="text-base font-bold text-gray-900 flex items-center gap-2">
              <Paperclip size={16} className="text-[#0D6E6E]" /> Attachments / Annexures
              {annexures.length > 0 && (
                <span className="text-xs font-bold bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{annexures.length}</span>
              )}
            </h3>
            <p className="text-xs text-gray-400 mt-0.5 mb-4">Supporting documents. Name and tag each as Annexure 1, 2, … — all are shared as PDF with recipients.</p>

            <div onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }} onDragLeave={() => setIsDragging(false)} onDrop={handleDrop}
              className={`border-2 border-dashed rounded-xl p-5 text-center transition-colors ${isDragging ? "border-[#0D6E6E] bg-[#E6F4F4]" : "border-gray-200 hover:border-gray-300"}`}>
              <Upload className="w-7 h-7 mx-auto mb-2 text-gray-300" />
              <p className="text-sm text-gray-500">Drag files here or <label className="text-[#0D6E6E] cursor-pointer hover:underline font-semibold">browse<input type="file" multiple accept={ALLOWED_ATTACHMENT_ACCEPT} className="sr-only" onChange={(e) => { attachmentQueue.addFiles(e.target.files); e.target.value = ""; }} /></label></p>
              <p className="text-xs text-gray-400 mt-1">{ALLOWED_ATTACHMENT_HELP_TEXT} · Max 10 MB each · Up to 10 files</p>
            </div>

            {annexures.length > 0 && (
              <div className="space-y-2 mt-3">
                {annexures.map((ann, i) => (
                  <div key={i} className="p-3 bg-gray-50 rounded-xl border border-gray-100">
                    <div className="flex items-center gap-2 mb-2">
                      <FileText className="w-4 h-4 text-[#0D6E6E] shrink-0" />
                      <span className="text-xs text-gray-400 ml-auto shrink-0">{(ann.file.size / 1024).toFixed(0)} KB</span>
                      <button type="button" onClick={() => attachmentQueue.removeItem(i)} className="text-red-400 hover:text-red-600 shrink-0"><X size={14} /></button>
                    </div>
                    <label className="block text-[11px] font-medium text-gray-500 mb-1">File Name</label>
                    <input value={ann.name} onChange={(e) => attachmentQueue.renameItem(i, e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#0D6E6E]" />
                    <label className="block text-[11px] font-medium text-gray-500 mt-2 mb-1">Tag</label>
                    <select value={ann.tag} onChange={(e) => attachmentQueue.setTag(i, e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#0D6E6E]">
                      {ATTACHMENT_TAGS.map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                    {ann.tag === CUSTOM_TAG_VALUE && (
                      <input
                        value={ann.customTag ?? ""}
                        onChange={(e) => attachmentQueue.setCustomTag(i, e.target.value)}
                        placeholder="Enter custom tag…"
                        maxLength={60}
                        autoFocus
                        className="mt-1.5 w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#0D6E6E]"
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* ── Notesheet — full page width ── */}
      <section className={`${cardCls} overflow-hidden`}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-200">
          <h3 className="text-base font-bold text-gray-900">Official Notesheet *</h3>
          <p className="text-xs text-gray-400">Paste from Word / PDF — formatting is preserved</p>
        </div>
        <RichTextToolbar editor={editor} />
        <EditorContent editor={editor} className="min-h-[560px]" />
        {editor && (
          <div className="px-5 py-2 border-t border-gray-100 text-xs text-gray-400 text-right">
            Words: {editor.getText().split(/\s+/).filter(Boolean).length}
          </div>
        )}
      </section>

      {/* ── Actions — full page width ── */}
      <div className="flex flex-wrap justify-end gap-3 pb-4">
        <button type="button" onClick={handleSaveChanges} disabled={createFile.isPending || !isDirty}
          className="flex items-center gap-2 px-6 py-3 border-2 border-[#0D6E6E] text-[#0D6E6E] text-sm font-bold rounded-xl hover:bg-[#E6F4F4] disabled:opacity-50 disabled:cursor-not-allowed">
          {createFile.isPending ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          {createFile.isPending ? "Saving…" : "Save Changes"}
        </button>
        <button type="submit" className="flex items-center gap-2 px-7 py-3 bg-[#0D6E6E] text-white text-sm font-bold rounded-xl hover:bg-[#178F8F]">
          <Send size={16} /> Review &amp; Submit
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
              <div><h3 className="text-xl font-bold text-gray-900">Confirm</h3><p className="text-base text-gray-500">Save as a Draft (not sent to anyone yet), or Forward it directly to the recipient below now.</p></div>
            </div>
            <div className="bg-gray-50 rounded-xl p-4 space-y-2 mb-6 text-base">
              <div><span className="font-semibold text-gray-600">Subject:</span> <span>{subject}</span></div>
              <div><span className="font-semibold text-gray-600">Category:</span> <span>{category}</span></div>
              <div><span className="font-semibold text-gray-600">Priority:</span> <span className="capitalize">{priority}</span></div>
              {isConfidential && <div><span className="font-semibold text-gray-600">Confidential:</span> <span className="text-purple-700 font-semibold">Yes — restricted to sender and recipient only</span></div>}
              <div className="flex items-start gap-2"><span className="font-semibold text-gray-600 shrink-0">Intended recipient:</span> {selectedRecipient ? <PersonBadge person={selectedRecipient} compact /> : <span>Not chosen yet</span>}</div>
              {annexures.length > 0 && <div><span className="font-semibold text-gray-600">Annexures:</span> <span>{annexures.map((a) => resolveAttachmentTag(a)).join(", ")}</span></div>}
            </div>
            <div className="flex gap-3">
              <button type="button" onClick={() => setConfirm(false)} className="flex-1 px-5 py-3 text-base border border-gray-200 rounded-xl hover:bg-gray-50 font-medium">Edit</button>
              <button type="button" onClick={() => createFile.mutate()} disabled={createFile.isPending || createAndForwardFile.isPending}
                className="flex-1 px-5 py-3 text-base border-2 border-[#0D6E6E] text-[#0D6E6E] rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-[#E6F4F4] disabled:opacity-50">
                {createFile.isPending ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
                {createFile.isPending ? "Saving…" : "Save Draft"}
              </button>
              <button
                type="button"
                title={!selectedRecipient ? "Choose a recipient above first" : undefined}
                onClick={() => {
                  if (!selectedRecipient) { toast.error("Please choose a recipient before forwarding."); return; }
                  if (isNotesheetEmpty(editor?.getHTML())) { toast.error("Please write the notesheet before forwarding this file."); return; }
                  createAndForwardFile.mutate();
                }}
                disabled={createFile.isPending || createAndForwardFile.isPending || !selectedRecipient}
                className="flex-1 px-5 py-3 text-base bg-[#0D6E6E] text-white rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-[#178F8F] disabled:opacity-50 disabled:cursor-not-allowed">
                {createAndForwardFile.isPending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                {createAndForwardFile.isPending ? "Forwarding…" : "Forward"}
              </button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
