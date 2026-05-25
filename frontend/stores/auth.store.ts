import { create } from "zustand";
import { persist } from "zustand/middleware";

export type EfmsRole =
  | "efms_officer" | "efms_admin" | "registrar" | "dispatch_officer"
  | "hod" | "faculty" | "admin" | "super_admin";

export interface AuthUser {
  id: string;
  email: string;
  full_name: string;
  designation?: string;
  department?: string;
  kyc_completed: boolean;
  roles: EfmsRole[];
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
        set({ user, accessToken, refreshToken, activeRole: user.roles[0] ?? null }),
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
export const useActiveRole = () => useAuthStore((s) => s.activeRole);
export const useHasRole = (...roles: EfmsRole[]) => useAuthStore((s) => s.activeRole != null && roles.includes(s.activeRole));
