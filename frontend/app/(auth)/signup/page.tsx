"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Loader2, CheckCircle2, ChevronRight, Eye, EyeOff } from "lucide-react";
import { api } from "@/services/api";
import { toast } from "sonner";

interface Establishment { id: string; name: string; }
interface Department { id: string; name: string; establishment_id: string; }

const INPUT = "w-full border border-gray-300 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]";
const LABEL = "block text-base font-semibold text-gray-700 mb-2";

export default function SignupPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    first_name: "", last_name: "", date_of_birth: "", designation: "",
    employee_code: "", email: "", mobile: "",
    establishment_id: "", department_id: "",
    password: "", confirm_password: "", email_otp: "",
  });
  const [showPwd, setShowPwd] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  const { data: establishments = [] } = useQuery<Establishment[]>({
    queryKey: ["establishments"],
    queryFn: async () => (await api.get("/admin/establishments")).data,
  });

  const { data: departments = [] } = useQuery<Department[]>({
    queryKey: ["departments", form.establishment_id],
    queryFn: async () => (await api.get(`/admin/departments?establishment_id=${form.establishment_id}`)).data,
    enabled: !!form.establishment_id,
  });

  const sendOtp = useMutation({
    mutationFn: () => api.post("/auth/otp/send", { target: form.email, otp_type: "email" }),
    onSuccess: (res) => {
      setOtpSent(true);
      const devOtp = res.data?.dev_otp;
      toast.success(`OTP sent. ${devOtp ? `[DEV OTP: ${devOtp}]` : ""}`);
    },
    onError: () => setError("Failed to send OTP. Check your email address."),
  });

  const signup = useMutation({
    mutationFn: () => api.post("/auth/signup", {
      ...form,
      establishment_id: form.establishment_id || undefined,
      department_id: form.department_id || undefined,
    }),
    onSuccess: () => setSubmitted(true),
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? "Signup failed. Please try again.");
    },
  });

  function set(field: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const val = e.target.value;
      setForm((f) => field === "establishment_id"
        ? { ...f, establishment_id: val, department_id: "" }
        : { ...f, [field]: val });
    };
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    if (form.password !== form.confirm_password) { setError("Passwords do not match."); return; }
    if (!otpSent || !form.email_otp) { setError("Please verify your email with OTP first."); return; }
    signup.mutate();
  }

  if (submitted) return (
    <div className="min-h-screen bg-[#F5F7FA] flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-10 max-w-md w-full text-center">
        <CheckCircle2 size={56} className="text-green-500 mx-auto mb-4" />
        <h2 className="text-2xl font-bold text-gray-900 mb-2">Request Submitted</h2>
        <p className="text-base text-gray-600">Your registration is pending admin approval.</p>
        <button onClick={() => router.push("/login")}
          className="mt-6 px-6 py-3 bg-[#0D6E6E] text-white rounded-xl text-base font-semibold hover:bg-[#178F8F]">
          Back to Sign In
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#F5F7FA] p-6">
      <div className="w-full max-w-5xl mx-auto">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-[#1A1A2E]">Request Access</h1>
          <p className="text-lg text-[#4A5568] mt-1">Fill in your details. An admin will approve your account.</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 space-y-5">
          {error && (
            <div className="p-3.5 bg-red-50 border border-red-200 rounded-xl text-red-700 text-base">{error}</div>
          )}

          {/* Row 1: Name + DOB + Designation */}
          <div className="grid grid-cols-3 gap-5">
            <div>
              <label className={LABEL}>First Name *</label>
              <input value={form.first_name} onChange={set("first_name")} placeholder="First name" required className={INPUT} />
            </div>
            <div>
              <label className={LABEL}>Last Name *</label>
              <input value={form.last_name} onChange={set("last_name")} placeholder="Last name" required className={INPUT} />
            </div>
            <div>
              <label className={LABEL}>Date of Birth</label>
              <input type="date" value={form.date_of_birth} onChange={set("date_of_birth")} className={INPUT} />
            </div>
          </div>

          {/* Row 2: Designation + Employee Code + Mobile */}
          <div className="grid grid-cols-3 gap-5">
            <div>
              <label className={LABEL}>Designation *</label>
              <input value={form.designation} onChange={set("designation")} placeholder="e.g. Assistant Professor" required className={INPUT} />
            </div>
            <div>
              <label className={LABEL}>Employee Code</label>
              <input value={form.employee_code} onChange={set("employee_code")} placeholder="Employee/Staff ID" className={INPUT} />
            </div>
            <div>
              <label className={LABEL}>Mobile Number *</label>
              <input type="tel" value={form.mobile} onChange={set("mobile")} placeholder="+91 XXXXX XXXXX" required className={INPUT} />
            </div>
          </div>

          {/* Row 3: Establishment + Department */}
          <div className="grid grid-cols-2 gap-5">
            <div>
              <label className={LABEL}>Establishment *</label>
              <select value={form.establishment_id} onChange={set("establishment_id")} required className={INPUT}>
                <option value="">Select establishment…</option>
                {establishments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
            <div>
              <label className={LABEL}>Department / Office *</label>
              <select value={form.department_id} onChange={set("department_id")} required
                disabled={!form.establishment_id} className={`${INPUT} disabled:bg-gray-50`}>
                <option value="">Select department…</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className={LABEL}>Email Address *</label>
            <div className="flex gap-2">
              <input type="email" value={form.email} onChange={set("email")} placeholder="your@avfu.ac.in" required
                className="flex-1 border border-gray-300 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]" />
              <button type="button" onClick={() => sendOtp.mutate()} disabled={!form.email || sendOtp.isPending}
                className="px-4 py-3 bg-[#0D6E6E] text-white rounded-xl text-base font-medium hover:bg-[#178F8F] disabled:opacity-50 whitespace-nowrap flex items-center gap-2">
                {sendOtp.isPending && <Loader2 size={14} className="animate-spin" />}
                {otpSent ? "Resend" : "Send OTP"}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-5">
            <div>
              <label className={LABEL}>Password *</label>
              <div className="relative">
                <input type={showPwd ? "text" : "password"} value={form.password} onChange={set("password")}
                  placeholder="Min 8 characters" required className={`${INPUT} pr-11`} />
                <button type="button" onClick={() => setShowPwd((p) => !p)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
                  {showPwd ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </div>
            <div>
              <label className={LABEL}>Confirm Password *</label>
              <input type="password" value={form.confirm_password} onChange={set("confirm_password")}
                placeholder="Repeat password" required className={INPUT} />
            </div>
            {otpSent && (
              <div>
                <label className={LABEL}>Email OTP *</label>
                <input value={form.email_otp} onChange={set("email_otp")} placeholder="6-digit OTP" maxLength={6}
                  className={`${INPUT} text-center tracking-widest font-mono`} />
              </div>
            )}
          </div>

          <button type="submit" disabled={signup.isPending || !otpSent}
            className="w-full flex items-center justify-center gap-2 py-4 bg-[#0D6E6E] text-white text-lg font-bold rounded-xl hover:bg-[#178F8F] disabled:opacity-50">
            {signup.isPending ? <Loader2 size={20} className="animate-spin" /> : <ChevronRight size={20} />}
            {signup.isPending ? "Submitting…" : "Submit Registration Request"}
          </button>

          <p className="text-center text-base text-gray-500">
            Already have an account?{" "}
            <a href="/login" className="text-[#0D6E6E] font-semibold hover:underline">Sign In</a>
          </p>
        </form>
      </div>
    </div>
  );
}
