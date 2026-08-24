"use client";
// Unauthenticated self-service password recovery — reuses the exact same
// step-indicator / OTP-input / password-field conventions already used by
// login/page.tsx (2-step OTP) and change-password/page.tsx (current/new/
// confirm password), rather than inventing new form patterns. 4 steps:
// email -> OTP -> new password -> success.
//
// The backend never confirms whether a given email has an account (same
// anti-enumeration principle login/step1 already applies to wrong email vs
// wrong password) — every step just advances optimistically off a generic
// success message. Reset identity is proven by a server-issued reset_token
// (returned only after OTP verification succeeds), never by resending the
// email/user id — the frontend only ever carries that opaque token forward.
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Mail, Lock, Eye, EyeOff, ChevronRight, AlertCircle, Loader2, ArrowLeft, CheckCircle2 } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/services/api";
import { toast } from "sonner";

type Step = "email" | "otp" | "password" | "success";

export default function ForgotPasswordPage() {
  const router = useRouter();

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState("");

  const requestOtp = useMutation({
    mutationFn: () => api.post("/auth/forgot-password", { email: email.trim() }),
    onSuccess: (res) => {
      setError("");
      setOtp("");
      setStep("otp");
      toast.success(res.data?.message ?? "If an account exists for this email, an OTP has been sent.");
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? "Could not send OTP. Please try again.");
    },
  });

  const verifyOtp = useMutation({
    mutationFn: () => api.post("/auth/forgot-password/verify", { email: email.trim(), otp }),
    onSuccess: (res) => {
      setError("");
      setResetToken(res.data.reset_token);
      setStep("password");
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? "Invalid or expired OTP. Please try again.");
    },
  });

  const resetPassword = useMutation({
    mutationFn: () =>
      api.post("/auth/forgot-password/reset", {
        reset_token: resetToken,
        new_password: newPassword,
        confirm_password: confirmPassword,
      }),
    onSuccess: () => {
      setError("");
      setStep("success");
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? "Could not reset password. Please start again.");
    },
  });

  function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    requestOtp.mutate();
  }

  function handleOtpSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    verifyOtp.mutate();
  }

  function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) { setError("New password and confirmation do not match."); return; }
    resetPassword.mutate();
  }

  return (
    <div className="min-h-screen bg-[#F5F7FA] flex items-center justify-center p-6">
      <div className="w-full max-w-[480px]">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-[#1A1A2E]">Reset Your Password</h1>
          <p className="text-lg text-[#4A5568] mt-1">AVFU Electronic File Management System</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          {error && (
            <div className="mb-5 flex items-start gap-3 p-3.5 bg-red-50 border border-red-200 rounded-xl text-red-700 text-base">
              <AlertCircle size={18} className="shrink-0 mt-0.5" /><span>{error}</span>
            </div>
          )}

          {/* ── Step 1: email ── */}
          {step === "email" && (
            <form onSubmit={handleEmailSubmit} className="space-y-4">
              <p className="text-sm text-gray-500 mb-2">
                Enter the email address on your account. We&apos;ll send a one-time password (OTP) to verify it&apos;s you.
              </p>
              <div>
                <label className="block text-base font-semibold text-gray-700 mb-2">Email Address</label>
                <div className="relative">
                  <Mail size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    type="email"
                    placeholder="your@avfu.ac.in"
                    required
                    autoFocus
                    className="w-full border border-gray-300 rounded-xl pl-11 pr-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]"
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={requestOtp.isPending}
                className="w-full flex items-center justify-center gap-2 py-3.5 bg-[#0D6E6E] text-white text-base font-bold rounded-xl hover:bg-[#178F8F] disabled:opacity-50 mt-2"
              >
                {requestOtp.isPending ? <Loader2 size={18} className="animate-spin" /> : <ChevronRight size={18} />}
                {requestOtp.isPending ? "Sending…" : "Send OTP"}
              </button>
              <Link href="/login" className="w-full flex items-center justify-center gap-1.5 py-2 text-sm text-gray-500 hover:text-gray-700">
                <ArrowLeft size={14} /> Back to Sign In
              </Link>
            </form>
          )}

          {/* ── Step 2: OTP ── */}
          {step === "otp" && (
            <form onSubmit={handleOtpSubmit} className="space-y-4">
              <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800">
                If an account exists for <span className="font-semibold">{email.trim()}</span>, an OTP has been sent to it. Enter it below.
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-base font-semibold text-gray-700">One-Time Password</label>
                  <button
                    type="button"
                    onClick={() => requestOtp.mutate()}
                    disabled={requestOtp.isPending}
                    className="text-sm text-[#0D6E6E] hover:underline disabled:opacity-50 flex items-center gap-1"
                  >
                    {requestOtp.isPending && <Loader2 size={13} className="animate-spin" />}
                    Resend OTP
                  </button>
                </div>
                <input
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="Enter 6-digit OTP"
                  maxLength={6}
                  required
                  autoFocus
                  className="w-full border border-gray-300 rounded-xl px-4 py-3 text-base text-center tracking-widest font-mono focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]"
                />
              </div>
              <button
                type="submit"
                disabled={verifyOtp.isPending || otp.length < 6}
                className="w-full flex items-center justify-center gap-2 py-3.5 bg-[#0D6E6E] text-white text-base font-bold rounded-xl hover:bg-[#178F8F] disabled:opacity-50 mt-2"
              >
                {verifyOtp.isPending ? <Loader2 size={18} className="animate-spin" /> : <ChevronRight size={18} />}
                {verifyOtp.isPending ? "Verifying…" : "Verify OTP"}
              </button>
              <button
                type="button"
                onClick={() => { setStep("email"); setError(""); setOtp(""); }}
                className="w-full flex items-center justify-center gap-1.5 py-2 text-sm text-gray-500 hover:text-gray-700"
              >
                <ArrowLeft size={14} /> Back
              </button>
            </form>
          )}

          {/* ── Step 3: new password ── */}
          {step === "password" && (
            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              <p className="text-sm text-gray-500 mb-2">Choose a new password for your account.</p>
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
                    autoFocus
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
                disabled={resetPassword.isPending}
                className="w-full flex items-center justify-center gap-2 py-3.5 bg-[#0D6E6E] text-white text-base font-bold rounded-xl hover:bg-[#178F8F] disabled:opacity-50 mt-2"
              >
                {resetPassword.isPending ? <Loader2 size={18} className="animate-spin" /> : <ChevronRight size={18} />}
                {resetPassword.isPending ? "Saving…" : "Reset Password"}
              </button>
            </form>
          )}

          {/* ── Step 4: success ── */}
          {step === "success" && (
            <div className="text-center space-y-4">
              <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto">
                <CheckCircle2 size={28} className="text-green-600" />
              </div>
              <p className="text-lg font-bold text-gray-900">Password Reset Successfully</p>
              <p className="text-base text-gray-500">You can now sign in with your new password.</p>
              <button
                onClick={() => router.replace("/login")}
                className="w-full flex items-center justify-center gap-2 py-3.5 bg-[#0D6E6E] text-white text-base font-bold rounded-xl hover:bg-[#178F8F] mt-2"
              >
                Go to Sign In
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
