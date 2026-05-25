"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Mail, Lock, Eye, EyeOff, Phone, ChevronRight, AlertCircle, Loader2 } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth.store";
import { toast } from "sonner";

type LoginMode = "password" | "email-otp" | "mobile-otp";

export default function LoginPage() {
  const router = useRouter();
  const { setAuth } = useAuthStore();
  const [mode, setMode] = useState<LoginMode>("password");
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [error, setError] = useState("");

  const sendOtp = useMutation({
    mutationFn: () => api.post("/auth/otp/send", {
      target: mode === "email-otp" ? email : mobile,
      otp_type: mode === "email-otp" ? "email" : "mobile",
    }),
    onSuccess: (res) => {
      setOtpSent(true);
      const devOtp = res.data?.dev_otp;
      toast.success(`OTP sent. ${devOtp ? `[DEV: ${devOtp}]` : ""}`);
    },
    onError: () => setError("Failed to send OTP. Please try again."),
  });

  const loginMutation = useMutation({
    mutationFn: () => {
      if (mode === "password") return api.post("/auth/login", { email, password });
      if (mode === "mobile-otp") return api.post("/auth/login/mobile-otp", { mobile, otp });
      return api.post("/auth/login/otp", { email, otp });
    },
    onSuccess: (res) => {
      const { user, access_token, refresh_token } = res.data;
      setAuth(user, access_token, refresh_token);
      toast.success(`Welcome, ${user.full_name}`);
      // Admins go directly to admin panel; others go to dashboard
      const isAdmin = ["admin", "super_admin"].includes(user.active_role ?? "");
      router.replace(isAdmin ? "/admin" : "/dashboard");
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? "Sign in failed. Please check your credentials.");
    },
  });

  const MODES: { id: LoginMode; label: string }[] = [
    { id: "password", label: "Password" },
    { id: "email-otp", label: "Email OTP" },
    { id: "mobile-otp", label: "Mobile OTP" },
  ];

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    loginMutation.mutate();
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
          {/* Mode selector */}
          <div className="flex rounded-xl border border-gray-200 mb-6 overflow-hidden">
            {MODES.map((m) => (
              <button key={m.id} onClick={() => { setMode(m.id); setOtpSent(false); setError(""); }}
                className={`flex-1 py-2.5 text-base font-medium transition-colors ${mode === m.id ? "bg-[#0D6E6E] text-white" : "text-gray-600 hover:bg-gray-50"}`}>
                {m.label}
              </button>
            ))}
          </div>

          {error && (
            <div className="mb-5 flex items-start gap-3 p-3.5 bg-red-50 border border-red-200 rounded-xl text-red-700 text-base">
              <AlertCircle size={18} className="shrink-0 mt-0.5" /><span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Email / Mobile input */}
            {(mode === "password" || mode === "email-otp") && (
              <div>
                <label className="block text-base font-semibold text-gray-700 mb-2">Email Address</label>
                <div className="relative">
                  <Mail size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input value={email} onChange={(e) => setEmail(e.target.value)} type="email"
                    placeholder="your@avfu.ac.in" required
                    className="w-full border border-gray-300 rounded-xl pl-11 pr-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]" />
                </div>
              </div>
            )}

            {mode === "mobile-otp" && (
              <div>
                <label className="block text-base font-semibold text-gray-700 mb-2">Mobile Number</label>
                <div className="relative">
                  <Phone size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input value={mobile} onChange={(e) => setMobile(e.target.value)} type="tel"
                    placeholder="+91 XXXXX XXXXX" required
                    className="w-full border border-gray-300 rounded-xl pl-11 pr-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]" />
                </div>
              </div>
            )}

            {/* Password */}
            {mode === "password" && (
              <div>
                <label className="block text-base font-semibold text-gray-700 mb-2">Password</label>
                <div className="relative">
                  <Lock size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input value={password} onChange={(e) => setPassword(e.target.value)}
                    type={showPwd ? "text" : "password"} placeholder="Enter password" required
                    className="w-full border border-gray-300 rounded-xl pl-11 pr-12 py-3 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]" />
                  <button type="button" onClick={() => setShowPwd((p) => !p)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    {showPwd ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>
              </div>
            )}

            {/* OTP section */}
            {(mode === "email-otp" || mode === "mobile-otp") && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-base font-semibold text-gray-700">OTP</label>
                  <button type="button" onClick={() => sendOtp.mutate()}
                    disabled={sendOtp.isPending || (!email && !mobile)}
                    className="text-sm text-[#0D6E6E] hover:underline disabled:opacity-50 flex items-center gap-1">
                    {sendOtp.isPending ? <Loader2 size={13} className="animate-spin" /> : null}
                    {otpSent ? "Resend OTP" : "Send OTP"}
                  </button>
                </div>
                <input value={otp} onChange={(e) => setOtp(e.target.value)}
                  placeholder="Enter 6-digit OTP" maxLength={6} required
                  className="w-full border border-gray-300 rounded-xl px-4 py-3 text-base text-center tracking-widest font-mono focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]" />
              </div>
            )}

            <button type="submit" disabled={loginMutation.isPending}
              className="w-full flex items-center justify-center gap-2 py-3.5 bg-[#0D6E6E] text-white text-base font-bold rounded-xl hover:bg-[#178F8F] disabled:opacity-50 mt-2">
              {loginMutation.isPending ? <Loader2 size={18} className="animate-spin" /> : <ChevronRight size={18} />}
              {loginMutation.isPending ? "Signing in…" : "Sign In"}
            </button>
          </form>

          <p className="text-center text-base text-gray-500 mt-5">
            New user?{" "}
            <a href="/signup" className="text-[#0D6E6E] font-semibold hover:underline">Request Access</a>
          </p>
        </div>

      </div>
    </div>
  );
}
