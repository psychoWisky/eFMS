import { create } from "zustand";
import { persist } from "zustand/middleware";

export type EfmsRole =
  | "efms_officer" | "efms_admin" | "registrar" | "dispatch_officer"
  | "hod" | "faculty" | "admin" | "super_admin";

export interface HeldRole {
  id: string;
  role: string;
  department_id?: string | null;
  department_name?: string | null;
  establishment_id?: string | null;
  establishment_name?: string | null;
}

export interface AuthUser {
  id: string;
  email: string;
  full_name: string;
  designation?: string;
  department?: string;
  department_id?: string | null;
  department_name?: string | null;
  establishment_id?: string | null;
  establishment_name?: string | null;
  kyc_completed: boolean;
  must_change_password: boolean;
  roles: EfmsRole[];
  held_roles?: HeldRole[];
  // The role this token is acting as. For a multi-role user this is the one
  // they last switched to; may differ from roles[0].
  active_role?: EfmsRole | null;
  can_sign: boolean;
  is_active?: boolean;
  // Present only on a project (PI) profile — used by the profile switcher
  // to show which project a "<Name> PI…" identity belongs to.
  project_number?: string | null;
  project_name?: string | null;
}

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  activeRole: EfmsRole | null;
  isLoading: boolean;
  setAuth: (user: AuthUser, access: string, refresh: string) => void;
  updateUser: (patch: Partial<AuthUser>) => void;
  setRole: (role: EfmsRole) => void;
  clearAuth: () => void;
  setLoading: (v: boolean) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      activeRole: null,
      isLoading: false,
      setAuth: (user, accessToken, refreshToken) =>
        set({ user, accessToken, refreshToken, activeRole: user.active_role ?? user.roles[0] ?? null }),
      updateUser: (patch) =>
        set((s) => ({ user: s.user ? { ...s.user, ...patch } : null })),
      setRole: (role) => set({ activeRole: role }),
      clearAuth: () => set({ user: null, accessToken: null, refreshToken: null, activeRole: null }),
      setLoading: (isLoading) => set({ isLoading }),
    }),
    { name: "efms-auth", partialize: (s) => ({ user: s.user, accessToken: s.accessToken, refreshToken: s.refreshToken, activeRole: s.activeRole }) }
  )
);

export const useUser = () => useAuthStore((s) => s.user);
export const useIsAuthenticated = () => useAuthStore((s) => !!s.accessToken);
export const useMustChangePassword = () => useAuthStore((s) => !!s.user?.must_change_password);
export const useActiveRole = () => useAuthStore((s) => s.activeRole);
export const useHasRole = (...roles: EfmsRole[]) => useAuthStore((s) => s.activeRole != null && roles.includes(s.activeRole));
