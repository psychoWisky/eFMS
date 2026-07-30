"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Mail, Lock, Eye, EyeOff, ChevronRight, AlertCircle, Loader2, ArrowLeft } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth.store";
import { toast } from "sonner";

type Step = "credentials" | "otp";

export default function LoginPage() {
  const router = useRouter();
  const { setAuth } = useAuthStore();

  const [step, setStep] = useState<Step>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState("");

  // Step 1: verify password, receive OTP on email
  const step1 = useMutation({
    mutationFn: () => api.post("/auth/login/step1", { email: email.trim(), password }),
    onSuccess: (res) => {
      setError("");
      setOtp("");
      setStep("otp");
      const devOtp = res.data?.dev_otp;
      toast.success(`OTP sent to ${email.trim()}.${devOtp ? ` [DEV: ${devOtp}]` : ""}`);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? "Sign in failed. Please check your credentials.");
    },
  });

  // Step 2: submit OTP, receive JWT
  const step2 = useMutation({
    mutationFn: () => api.post("/auth/login/step2", { email: email.trim(), otp }),
    onSuccess: (res) => {
      const { user, access_token, refresh_token } = res.data;
      setAuth(user, access_token, refresh_token);
      toast.success(`Welcome, ${user.full_name}`);
      if (user.must_change_password) {
        router.replace("/change-password");
        return;
      }
      const isAdmin = ["admin", "super_admin"].includes(user.active_role ?? "");
      router.replace(isAdmin ? "/admin" : "/dashboard");
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? "OTP verification failed. Please try again.");
    },
  });

  // Resend OTP (re-runs step 1 silently)
  const resend = useMutation({
    mutationFn: () => api.post("/auth/login/step1", { email: email.trim(), password }),
    onSuccess: (res) => {
      setOtp("");
      setError("");
      const devOtp = res.data?.dev_otp;
      toast.success(`OTP resent.${devOtp ? ` [DEV: ${devOtp}]` : ""}`);
    },
    onError: () => toast.error("Failed to resend OTP. Please go back and try again."),
  });

  function handleCredentials(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    step1.mutate();
  }

  function handleOtp(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    step2.mutate();
  }

  return (
    <div className="min-h-screen bg-[#F5F7FA] flex items-center justify-center p-6">
      <div className="w-full max-w-[480px]">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-[#1A1A2E]">Sign In</h1>
          <p className="text-lg text-[#4A5568] mt-1">AVFU Electronic File Management System</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          {/* Step indicator */}
          <div className="flex items-center gap-2 mb-6">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-colors ${
              step === "credentials" ? "bg-[#0D6E6E] text-white" : "bg-green-500 text-white"
            }`}>
              {step === "otp" ? "✓" : "1"}
            </div>
            <div className={`flex-1 h-0.5 transition-colors ${step === "otp" ? "bg-[#0D6E6E]" : "bg-gray-200"}`} />
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-colors ${
              step === "otp" ? "bg-[#0D6E6E] text-white" : "bg-gray-200 text-gray-400"
            }`}>
              2
            </div>
          </div>
          <p className="text-sm text-gray-500 mb-6">
            {step === "credentials" ? "Step 1 — Verify your identity" : "Step 2 — Enter the OTP sent to your email"}
          </p>

          {error && (
            <div className="mb-5 flex items-start gap-3 p-3.5 bg-red-50 border border-red-200 rounded-xl text-red-700 text-base">
              <AlertCircle size={18} className="shrink-0 mt-0.5" /><span>{error}</span>
            </div>
          )}

          {/* ── Step 1: email + password ── */}
          {step === "credentials" && (
            <form onSubmit={handleCredentials} className="space-y-4">
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
                    className="w-full border border-gray-300 rounded-xl pl-11 pr-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-base font-semibold text-gray-700 mb-2">Password</label>
                <div className="relative">
                  <Lock size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    type={showPwd ? "text" : "password"}
                    placeholder="Enter password"
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

              <button
                type="submit"
                disabled={step1.isPending}
                className="w-full flex items-center justify-center gap-2 py-3.5 bg-[#0D6E6E] text-white text-base font-bold rounded-xl hover:bg-[#178F8F] disabled:opacity-50 mt-2"
              >
                {step1.isPending ? <Loader2 size={18} className="animate-spin" /> : <ChevronRight size={18} />}
                {step1.isPending ? "Verifying…" : "Continue"}
              </button>
            </form>
          )}

          {/* ── Step 2: OTP ── */}
          {step === "otp" && (
            <form onSubmit={handleOtp} className="space-y-4">
              <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800">
                An OTP has been sent to <span className="font-semibold">{email.trim()}</span>. Enter it below to sign in.
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-base font-semibold text-gray-700">One-Time Password</label>
                  <button
                    type="button"
                    onClick={() => resend.mutate()}
                    disabled={resend.isPending}
                    className="text-sm text-[#0D6E6E] hover:underline disabled:opacity-50 flex items-center gap-1"
                  >
                    {resend.isPending && <Loader2 size={13} className="animate-spin" />}
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
                disabled={step2.isPending || otp.length < 6}
                className="w-full flex items-center justify-center gap-2 py-3.5 bg-[#0D6E6E] text-white text-base font-bold rounded-xl hover:bg-[#178F8F] disabled:opacity-50 mt-2"
              >
                {step2.isPending ? <Loader2 size={18} className="animate-spin" /> : <ChevronRight size={18} />}
                {step2.isPending ? "Signing in…" : "Sign In"}
              </button>

              <button
                type="button"
                onClick={() => { setStep("credentials"); setError(""); setOtp(""); }}
                className="w-full flex items-center justify-center gap-1.5 py-2 text-sm text-gray-500 hover:text-gray-700"
              >
                <ArrowLeft size={14} /> Back to credentials
              </button>
            </form>
          )}

        </div>
      </div>
    </div>
  );
}
