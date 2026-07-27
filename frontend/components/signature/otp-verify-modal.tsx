"use client";
import { useState, useRef, useCallback } from "react";
import { ShieldCheck, Loader2, X, Mail } from "lucide-react";

interface Props {
  email: string;
  fileRef: string;
  onVerify: (otp: string) => Promise<void>;
  onClose: () => void;
  isLoading: boolean;
  error: string | null;
}

export default function OtpVerifyModal({ email, fileRef, onVerify, onClose, isLoading, error }: Props) {
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);

  const handleChange = useCallback((idx: number, val: string) => {
    const digit = val.replace(/\D/g, "").slice(-1);
    const next = [...digits];
    next[idx] = digit;
    setDigits(next);
    if (digit && idx < 5) {
      inputs.current[idx + 1]?.focus();
    }
  }, [digits]);

  const handleKeyDown = useCallback((idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !digits[idx] && idx > 0) {
      inputs.current[idx - 1]?.focus();
    }
    if (e.key === "ArrowLeft" && idx > 0) inputs.current[idx - 1]?.focus();
    if (e.key === "ArrowRight" && idx < 5) inputs.current[idx + 1]?.focus();
  }, [digits]);

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    const next = ["", "", "", "", "", ""];
    for (let i = 0; i < pasted.length; i++) next[i] = pasted[i];
    setDigits(next);
    const focusIdx = Math.min(pasted.length, 5);
    inputs.current[focusIdx]?.focus();
  };

  const otp = digits.join("");
  const isComplete = otp.length === 6;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isComplete && !isLoading) onVerify(otp);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-sm mx-4 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-zinc-700">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-emerald-500/20 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">Verify Signature</h2>
              <p className="text-xs text-zinc-400">{fileRef}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-5">
          <div className="flex items-start gap-3 bg-zinc-800/60 rounded-lg p-3">
            <Mail className="w-4 h-4 text-zinc-400 mt-0.5 shrink-0" />
            <p className="text-xs text-zinc-300 leading-relaxed">
              A 6-digit OTP has been sent to{" "}
              <span className="text-white font-medium">{email}</span>.
              Enter it below to confirm your digital signature.
            </p>
          </div>

          {/* OTP inputs */}
          <div className="flex gap-2 justify-center" onPaste={handlePaste}>
            {digits.map((d, i) => (
              <input
                key={i}
                ref={(el) => { inputs.current[i] = el; }}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={d}
                autoFocus={i === 0}
                onChange={(e) => handleChange(i, e.target.value)}
                onKeyDown={(e) => handleKeyDown(i, e)}
                className={`w-11 h-13 text-center text-xl font-bold rounded-lg border transition-all outline-none
                  bg-zinc-800 text-white
                  ${d ? "border-emerald-500 shadow-[0_0_0_2px_rgba(16,185,129,0.2)]" : "border-zinc-600"}
                  focus:border-emerald-400 focus:shadow-[0_0_0_2px_rgba(16,185,129,0.25)]
                `}
              />
            ))}
          </div>

          {error && (
            <p className="text-xs text-red-400 text-center bg-red-500/10 rounded-lg py-2 px-3">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!isComplete || isLoading}
            className="w-full py-2.5 rounded-xl font-semibold text-sm transition-all
              bg-emerald-600 hover:bg-emerald-500 text-white
              disabled:opacity-40 disabled:cursor-not-allowed
              flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Verifying…</>
            ) : (
              <><ShieldCheck className="w-4 h-4" /> Verify & Sign</>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
