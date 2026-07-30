"use client";
// Mandatory first-login password change. Lives outside the (protected) route
// group so it is reachable while must_change_password is still true — the
// (protected) layout redirects here and refuses everything else until the
// flag clears (see app/(protected)/layout.tsx).
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Eye, EyeOff, ChevronRight, AlertCircle, Loader2, LogOut } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useAuthStore, useIsAuthenticated, useMustChangePassword, useActiveRole } from "@/stores/auth.store";
import { toast } from "sonner";

export default function ChangePasswordPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { refreshToken, updateUser, clearAuth } = useAuthStore();
  const isAuthenticated = useIsAuthenticated();
  const mustChange = useMustChangePassword();
  const activeRole = useActiveRole();
  const [hydrated, setHydrated] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (useAuthStore.persist.hasHydrated()) setHydrated(true);
    else return useAuthStore.persist.onFinishHydration(() => setHydrated(true));
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (!isAuthenticated) { router.replace("/login"); return; }
    if (!mustChange) {
      const isAdmin = ["admin", "super_admin"].includes(activeRole ?? "");
      router.replace(isAdmin ? "/admin" : "/dashboard");
    }
  }, [hydrated, isAuthenticated, mustChange, router, activeRole]);

  const changePassword = useMutation({
    mutationFn: () => api.post("/auth/change-password", {
      current_password: currentPassword,
      new_password: newPassword,
      confirm_password: confirmPassword,
    }),
    onSuccess: () => {
      updateUser({ must_change_password: false });
      toast.success("Password changed successfully.");
      const isAdmin = ["admin", "super_admin"].includes(activeRole ?? "");
      router.replace(isAdmin ? "/admin" : "/dashboard");
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? "Could not change password. Please try again.");
    },
  });

  async function handleLogout() {
    try { await api.post("/auth/logout", { refresh_token: refreshToken }); } catch {}
    clearAuth();
    qc.clear();
    router.replace("/login");
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) { setError("New password and confirmation do not match."); return; }
    changePassword.mutate();
  }

  if (!hydrated || !isAuthenticated || !mustChange) return null;

  return (
    <div className="min-h-screen bg-[#F5F7FA] flex items-center justify-center p-6">
      <div className="w-full max-w-[480px]">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-[#1A1A2E]">Change Your Password</h1>
          <p className="text-lg text-[#4A5568] mt-1">
            You&apos;re using a temporary password. Set a new one to continue.
          </p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          <div className="mb-5 flex items-start gap-3 p-3.5 bg-blue-50 border border-blue-200 rounded-xl text-blue-800 text-sm">
            <AlertCircle size={18} className="shrink-0 mt-0.5" />
            <span>This is required before you can access the rest of the system.</span>
          </div>

          {error && (
            <div className="mb-5 flex items-start gap-3 p-3.5 bg-red-50 border border-red-200 rounded-xl text-red-700 text-base">
              <AlertCircle size={18} className="shrink-0 mt-0.5" /><span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-base font-semibold text-gray-700 mb-2">Current (Temporary) Password</label>
              <div className="relative">
                <Lock size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  type={showPwd ? "text" : "password"}
                  required
                  className="w-full border border-gray-300 rounded-xl pl-11 pr-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]"
                />
              </div>
            </div>

            <div>
              <label className="block text-base font-semibold text-gray-700 mb-2">New Password</label>
              <div className="relative">
                <Lock size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  type={showPwd ? "text" : "password"}
                  placeholder="Min 8 characters, incl. upper, lower, digit"
                  required
                  className="w-full border border-gray-300 rounded-xl pl-11 pr-12 py-3 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]"
                />
                <button
                  type="button"
                  onClick={() => setShowPwd((p) => !p)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showPwd ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-base font-semibold text-gray-700 mb-2">Confirm New Password</label>
              <input
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                type={showPwd ? "text" : "password"}
                required
                className="w-full border border-gray-300 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]"
              />
            </div>

            <button
              type="submit"
              disabled={changePassword.isPending}
              className="w-full flex items-center justify-center gap-2 py-3.5 bg-[#0D6E6E] text-white text-base font-bold rounded-xl hover:bg-[#178F8F] disabled:opacity-50 mt-2"
            >
              {changePassword.isPending ? <Loader2 size={18} className="animate-spin" /> : <ChevronRight size={18} />}
              {changePassword.isPending ? "Updating…" : "Change Password"}
            </button>
          </form>

          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-1.5 py-2 mt-3 text-sm text-gray-500 hover:text-gray-700"
          >
            <LogOut size={14} /> Sign out instead
          </button>
        </div>
      </div>
    </div>
  );
}
