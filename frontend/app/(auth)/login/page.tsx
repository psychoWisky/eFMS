"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { Lock, Eye, EyeOff, ChevronRight, AlertCircle, Loader2, ArrowLeft, UserRound } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth.store";
import { toast } from "sonner";
import { showSuccess } from "@/lib/alert";

type Step = "credentials" | "otp";

// Plain-language message for a failed sign-in call. The backend's own
// message is used when it sent one (wrong password, wrong OTP, deactivated,
// …); the rest — no connection, server error, malformed input — are mapped
// here so the user never sees a raw error.
function loginErrorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { status?: number; data?: { detail?: unknown } }; code?: string };
  if (!e?.response) return "Can't reach the server right now. Please check your internet connection and try again.";
  const { status, data } = e.response;
  if (typeof data?.detail === "string" && data.detail) return data.detail;
  if (status === 422) return "Please enter a valid email address or mobile number, and your password.";
  if (status && status >= 500) return "Something went wrong on our side. Please try again in a moment.";
  return fallback;
}

// Anything without "@" is treated as a mobile number (the backend decides the
// same way); catch obviously invalid ones before calling the server.
function mobileInputError(identifier: string): string | null {
  const v = identifier.trim();
  if (!v || v.includes("@")) return null;
  const digits = v.replace(/\D/g, "");
  const ten = digits.length === 12 && digits.startsWith("91") ? digits.slice(2)
    : digits.length === 11 && digits.startsWith("0") ? digits.slice(1)
    : digits;
  if (/[^0-9+\s-]/.test(v) || ten.length !== 10) {
    return "Enter a valid 10-digit mobile number, or your email address.";
  }
  return null;
}

export default function LoginPage() {
  const router = useRouter();
  const { setAuth } = useAuthStore();

  const [step, setStep] = useState<Step>("credentials");
  // Email address or mobile number — the backend accepts either.
  const [identifier, setIdentifier] = useState("");
  // The OTP goes where the user signed in with: email → email OTP, mobile
  // number → SMS OTP (the backend decides the same way).
  const channel = identifier.includes("@") ? "email" : "mobile";
  // Masked destination from the backend, e.g. "******4321" / "ab***@avfu.ac.in".
  const [destination, setDestination] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState("");

  const sendOtp = () => api.post("/auth/login/step1", { identifier: identifier.trim(), password });

  // Step 1: verify password, receive OTP on the chosen channel
  const step1 = useMutation({
    mutationFn: sendOtp,
    onSuccess: (res) => {
      setError("");
      setOtp("");
      setDestination(res.data?.destination ?? "");
      setStep("otp");
      const devOtp = res.data?.dev_otp;
      toast.success(`${res.data?.message ?? "OTP sent."}${devOtp ? ` [DEV: ${devOtp}]` : ""}`);
    },
    onError: (err: unknown) => {
      setError(loginErrorMessage(err, "Sign in failed. Please check your details and try again."));
    },
  });

  // Step 2: submit OTP, receive JWT
  const step2 = useMutation({
    mutationFn: () => api.post("/auth/login/step2", { identifier: identifier.trim(), otp }),
    onSuccess: (res) => {
      const { user, access_token, refresh_token } = res.data;
      setAuth(user, access_token, refresh_token);
      showSuccess(`Welcome, ${user.full_name}`);
      if (user.must_change_password) {
        router.replace("/change-password");
        return;
      }
      const isAdmin = ["admin", "super_admin"].includes(user.active_role ?? "");
      router.replace(isAdmin ? "/admin" : "/dashboard");
    },
    onError: (err: unknown) => {
      setError(loginErrorMessage(err, "The OTP could not be verified. Please try again."));
    },
  });

  // Resend OTP (re-runs step 1)
  const resend = useMutation({
    mutationFn: sendOtp,
    onSuccess: (res) => {
      setOtp("");
      setError("");
      setDestination(res.data?.destination ?? "");
      const devOtp = res.data?.dev_otp;
      toast.success(`${res.data?.message ?? "OTP resent."}${devOtp ? ` [DEV: ${devOtp}]` : ""}`);
    },
    onError: (err: unknown) => {
      toast.error(loginErrorMessage(err, "Couldn't resend the OTP. Please go back and try again."));
    },
  });


  function handleCredentials(e: React.FormEvent) {
    e.preventDefault();
    const bad = mobileInputError(identifier);
    if (bad) { setError(bad); return; }
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
          <div className="flex justify-center mb-4">
            <div className="w-20 h-20 rounded-2xl overflow-hidden bg-white shadow-md border border-gray-100 flex items-center justify-center">
              <Image src="/avfu_logo.png" alt="AVFU Logo" width={80} height={80} className="object-contain w-full h-full" />
            </div>
          </div>
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
            {step === "credentials"
              ? "Step 1 — Verify your identity"
              : `Step 2 — Enter the OTP sent to your ${channel === "mobile" ? "mobile" : "email"}`}
          </p>

          {error && (
            <div className="mb-5 flex items-start gap-3 p-3.5 bg-red-50 border border-red-200 rounded-xl text-red-700 text-base">
              <AlertCircle size={18} className="shrink-0 mt-0.5" /><span>{error}</span>
            </div>
          )}

          {/* ── Step 1: email or mobile + password ── */}
          {step === "credentials" && (
            <form onSubmit={handleCredentials} className="space-y-4">
              <div>
                <label className="block text-base font-semibold text-gray-700 mb-2">Email or Mobile Number</label>
                <div className="relative">
                  <UserRound size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    type="text"
                    inputMode="email"
                    autoComplete="username"
                    placeholder="your@avfu.ac.in or 98XXXXXXXX"
                    aria-describedby="identifier-hint"
                    required
                    className="w-full border border-gray-300 rounded-xl pl-11 pr-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]"
                  />
                </div>
                <p id="identifier-hint" className="text-sm text-gray-500 mt-1.5">
                  The OTP will be sent here — by email for an email address, by SMS for a mobile number.
                </p>
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
                <div className="flex justify-end mt-2">
                  <Link href="/forgot-password" className="text-sm text-[#0D6E6E] hover:underline">
                    Forgot Password?
                  </Link>
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
                An OTP has been sent to your {channel === "mobile" ? "mobile" : "email"}{" "}
                <span className="font-semibold">{destination}</span>. Enter it below to sign in.
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
