"use client";
// Single source of truth for the attachment-queue state and upload loop
// shared by every attachment screen (New File, Forward). Centralizes add/
// remove/rename/tag/custom-tag/validation/upload; each screen keeps its own
// visual layout around this shared state.
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/services/api";
import { CUSTOM_TAG_VALUE, isAllowedAttachmentFile, validateCustomTag } from "@/lib/attachment-constants";

export interface QueuedAttachment {
  file: File;
  name: string;
  tag: string;
  customTag?: string;
}

/** The tag actually used to build the upload filename — the custom text
 * when tag === "Other", otherwise the predefined tag unchanged. */
export function resolveAttachmentTag(item: QueuedAttachment): string {
  if (item.tag === CUSTOM_TAG_VALUE) {
    const custom = (item.customTag ?? "").trim();
    return custom || CUSTOM_TAG_VALUE;
  }
  return item.tag;
}

async function uploadOne(fileId: string, file: File, tag: string, displayName?: string): Promise<void> {
  const form = new FormData();
  form.append("upload", file, `${tag}-${displayName || file.name}`);
  await api.post(`/efms/files/${fileId}/attachments`, form, {
    headers: { "Content-Type": "multipart/form-data" },
  });
}

export function useAttachmentQueue(maxFiles = 10) {
  const [items, setItems] = useState<QueuedAttachment[]>([]);

  function addFiles(fileList: FileList | null) {
    if (!fileList) return;
    const files = Array.from(fileList);
    const accepted: QueuedAttachment[] = [];
    let rejected = 0;
    files.forEach((f, i) => {
      if (!isAllowedAttachmentFile(f.name)) { rejected++; return; }
      const idx = items.length + accepted.length + i + 1;
      accepted.push({ file: f, name: f.name, tag: `doc-${idx}` });
    });
    if (rejected > 0) {
      toast.error(`${rejected} file${rejected > 1 ? "s were" : " was"} rejected — unsupported file type.`);
    }
    setItems((prev) => [...prev, ...accepted].slice(0, maxFiles));
  }

  function removeItem(i: number) {
    setItems((prev) => prev.filter((_, idx) => idx !== i));
  }

  function renameItem(i: number, name: string) {
    setItems((prev) => prev.map((x, idx) => (idx === i ? { ...x, name } : x)));
  }

  function setTag(i: number, tag: string) {
    setItems((prev) => prev.map((x, idx) => (idx === i ? { ...x, tag } : x)));
  }

  function setCustomTag(i: number, customTag: string) {
    setItems((prev) => prev.map((x, idx) => (idx === i ? { ...x, customTag } : x)));
  }

  function clear() {
    setItems([]);
  }

  /** True if any queued item has an invalid custom tag — check before
   * submitting the parent form/action. */
  function hasInvalidCustomTags(): boolean {
    return items.some((it) => it.tag === CUSTOM_TAG_VALUE && validateCustomTag(it.customTag ?? "") !== null);
  }

  async function uploadAll(fileId: string) {
    for (const item of items) {
      await uploadOne(fileId, item.file, resolveAttachmentTag(item), item.name).catch(() => {});
    }
  }

  /** Upload files immediately, bypassing the local queue entirely — for
   * screens where the target file already exists and attachments must
   * persist to the server as soon as they're selected (e.g. the Forward
   * panel: an in-progress holder's uploads must survive closing the page
   * without forwarding, so they can't be held only in local UI state).
   * Reuses the same validated upload path as addFiles/uploadAll. Returns
   * the number of files actually uploaded. */
  async function uploadNow(fileId: string, fileList: FileList | null): Promise<number> {
    if (!fileList) return 0;
    const files = Array.from(fileList);
    let uploaded = 0, rejected = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!isAllowedAttachmentFile(f.name)) { rejected++; continue; }
      try {
        await uploadOne(fileId, f, `doc-${i + 1}`);
        uploaded++;
      } catch {
        rejected++;
      }
    }
    if (rejected > 0) {
      toast.error(`${rejected} file${rejected > 1 ? "s were" : " was"} rejected — unsupported file type or upload failed.`);
    }
    return uploaded;
  }

  return {
    items, addFiles, removeItem, renameItem, setTag, setCustomTag, clear,
    hasInvalidCustomTags, uploadAll, uploadNow,
  };
}
