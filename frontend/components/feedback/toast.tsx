"use client";
import { Toaster, toast as sonnerToast } from "sonner";

export function EfmsToaster() {
  return (
    <Toaster
      position="top-right"
      toastOptions={{
        style: {
          borderRadius: "12px",
          border: "1px solid #D1D9E0",
          fontSize: "14px",
          fontFamily: "inherit",
          boxShadow: "0 4px 16px rgba(0,0,0,.1)",
        },
        className: "efms-toast",
      }}
      richColors
    />
  );
}

export const toast = {
  success: (msg: string, opts?: object) => sonnerToast.success(msg, opts),
  error:   (msg: string, opts?: object) => sonnerToast.error(msg, opts),
  warning: (msg: string, opts?: object) => sonnerToast.warning(msg, opts),
  info:    (msg: string, opts?: object) => sonnerToast.info(msg, opts),
  loading: (msg: string, opts?: object) => sonnerToast.loading(msg, opts),
  promise: sonnerToast.promise,
  dismiss: sonnerToast.dismiss,
};
