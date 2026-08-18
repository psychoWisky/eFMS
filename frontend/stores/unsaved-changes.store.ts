import { create } from "zustand";

// Lets the currently-mounted "editing" component (New File, Edit Draft, the
// current-holder Notesheet editor, ...) register its dirty state and a
// Discard callback so components OUTSIDE its own React subtree — the
// sidebar, and the dashboard's own tab-switch buttons — can guard their
// navigation against it too. Only one editing context is ever active at a
// time in this app, so a single registration slot (not a list/map) is
// sufficient — matches the existing single-purpose store convention already
// used by stores/auth.store.ts (plain zustand `create`, no persistence
// needed here since this is purely in-memory session state).
//
// Deliberately has no `save` slot: the navigation guard only ever asks
// "leave or stay" — persisting changes happens exclusively through each
// page's own explicit "Save Changes" button, never as a side effect of
// navigating away.
interface UnsavedChangesState {
  isDirty: boolean;
  discard: (() => void) | null;
  register: (isDirty: boolean, discard: () => void) => void;
  unregister: () => void;
}

export const useUnsavedChangesStore = create<UnsavedChangesState>((set) => ({
  isDirty: false,
  discard: null,
  register: (isDirty, discard) => set({ isDirty, discard }),
  unregister: () => set({ isDirty: false, discard: null }),
}));
