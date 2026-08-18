"use client";
// Single reusable "unsaved changes" guard for every editing context in eFMS
// (New File, Edit Draft, the current-holder Notesheet editor). Its ONLY job
// is "if dirty, ask whether to leave or stay" — it never saves anything.
// Persisting changes happens exclusively through each page's own explicit
// "Save Changes" button; see modules/files/new-file-page.tsx and
// modules/files/notesheet-editor.tsx.
import { useEffect } from "react";
import { confirmLeaveUnsaved } from "@/lib/alert";
import { useUnsavedChangesStore } from "@/stores/unsaved-changes.store";

export interface UnsavedChangesGuardOptions {
  isDirty: boolean;
  /** Synchronously throw away the local unsaved changes (never touches
   * already-persisted backend data — only local/queued state). */
  onDiscard: () => void;
}

/** Runs `action` immediately if nothing is dirty; otherwise shows the
 * generic "Unsaved Changes" Leave/Stay dialog first. Exported standalone
 * (not just returned from the hook) so components outside the editing
 * context's own React subtree — the sidebar, the dashboard's tab buttons —
 * can guard their own navigation against whatever editing context is
 * currently registered, without needing a reference to that context's hook
 * instance. */
export async function guardedNavigate(action: () => void): Promise<void> {
  const { isDirty, discard } = useUnsavedChangesStore.getState();
  if (!isDirty) {
    action();
    return;
  }
  const leave = await confirmLeaveUnsaved();
  if (!leave) return; // Stay: do nothing.
  discard?.();
  action();
}

/** Registers the calling component's dirty state + Discard callback into the
 * shared store (for the sidebar/dashboard cases above), adds a native
 * `beforeunload` warning while dirty, and returns a `guardNavigation` helper
 * for the component's own internal exit points (Back button, router.push,
 * etc.) — same underlying guardedNavigate() logic either way, so there is
 * exactly one confirm/discard implementation. */
export function useUnsavedChangesGuard({ isDirty, onDiscard }: UnsavedChangesGuardOptions) {
  const register = useUnsavedChangesStore((s) => s.register);
  const unregister = useUnsavedChangesStore((s) => s.unregister);

  // Re-register on every render so the store always holds the latest
  // onDiscard closure (it captures component state that changes often) — a
  // cheap store write, not worth the staleness risk of trying to memoize a
  // callback that legitimately changes on nearly every keystroke.
  useEffect(() => {
    register(isDirty, onDiscard);
  });

  // Unregister only on unmount — a stale registration from a page the user
  // has left must never linger and guard an unrelated later navigation.
  useEffect(() => {
    return () => unregister();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Native browser-level warning for refresh/tab-close/window-close — the
  // one exit path no custom dialog can ever cover (browsers ignore any
  // custom message and show their own fixed prompt). Listener is added only
  // while dirty and removed the moment it isn't (e.g. right after a
  // successful Save Changes), per the requirement not to warn when there is
  // nothing to lose.
  useEffect(() => {
    if (!isDirty) return;
    function handler(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  return { guardNavigation: guardedNavigate };
}
