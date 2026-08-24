"use client";
// Voluntary, authenticated Change Password — reachable from the topnav user
// menu (see components/layouts/topnav.tsx) by ANY logged-in user regardless
// of role, including SUPER_ADMIN. Deliberately a SEPARATE page from the
// mandatory first-login app/change-password/page.tsx (which stays exactly
// as-is, gated to must_change_password) rather than reusing/branching that
// page — this one has no redirect guards of its own, since (protected)/
// layout.tsx already handles both "not authenticated" and "must change
// temporary password first" before any (protected) route (including this
// one) ever renders.
//
// Calls the SAME general-purpose POST /auth/change-password endpoint the
// mandatory flow uses — identity comes from the authenticated session
// (get_current_user server-side), never a client-supplied user id/email.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Eye, EyeOff, ChevronRight, AlertCircle, Loader2, CheckCircle2, ArrowLeft } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/services/api";

export default function VoluntaryChangePasswordPage() {
  const router = useRouter();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const changePassword = useMutation({
    mutationFn: () => api.post("/auth/change-password", {
      current_password: currentPassword,
      new_password: newPassword,
      confirm_password: confirmPassword,
    }),
    onSuccess: () => {
      setError("");
      setSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? "Could not change password. Please try again.");
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) { setError("New password and confirmation do not match."); return; }
    changePassword.mutate();
  }

  return (
    <div className="min-h-screen bg-[#F5F7FA] flex items-center justify-center p-6">
      <div className="w-full max-w-[480px]">
        <button onClick={() => router.back()} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-4">
          <ArrowLeft size={14} /> Back
        </button>

        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-[#1A1A2E]">Change Password</h1>
          <p className="text-lg text-[#4A5568] mt-1">Update your account password.</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          {success ? (
            <div className="text-center space-y-4">
              <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto">
                <CheckCircle2 size={28} className="text-green-600" />
              </div>
              <p className="text-lg font-bold text-gray-900">Password Changed Successfully</p>
              <p className="text-base text-gray-500">Use your new password the next time you sign in.</p>
              <button
                onClick={() => setSuccess(false)}
                className="w-full flex items-center justify-center gap-2 py-3 border border-gray-300 text-gray-700 text-base font-semibold rounded-xl hover:bg-gray-50"
              >
                Change Again
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="flex items-start gap-3 p-3.5 bg-red-50 border border-red-200 rounded-xl text-red-700 text-base">
                  <AlertCircle size={18} className="shrink-0 mt-0.5" /><span>{error}</span>
                </div>
              )}

              <div>
                <label className="block text-base font-semibold text-gray-700 mb-2">Current Password</label>
                <div className="relative">
                  <Lock size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    type={showPwd ? "text" : "password"}
                    required
                    autoFocus
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
                  <button type="button" onClick={() => setShowPwd((p) => !p)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
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
          )}
        </div>
      </div>
    </div>
  );
}
