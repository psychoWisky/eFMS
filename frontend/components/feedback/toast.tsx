"use client";
import { Toaster, toast as sonnerToast } from "sonner";

export function EfmsToaster() {
  return (
    <Toaster
      position="top-right"
      theme="light"
      richColors
      offset={16}
      // Show every toast in full instead of Sonner's collapsed stack, where
      // all but the front toast have their text hidden — back-to-back
      // messages (e.g. a validation error then a retry) stay readable.
      expand
      visibleToasts={4}
      closeButton
      toastOptions={{
        duration: 4500,
        style: {
          borderRadius: "12px",
          fontSize: "14px",
          fontFamily: "inherit",
          boxShadow: "0 8px 32px rgba(0,0,0,.18)",
        },
        className: "efms-toast",
      }}
    />
  );
}

export const toast = {
  success: (msg: string, opts?: object) => sonnerToast.success(msg, opts),
  error:   (msg: string, opts?: object) => sonnerToast.error(msg, { duration: 6000, ...opts }),
  warning: (msg: string, opts?: object) => sonnerToast.warning(msg, opts),
  info:    (msg: string, opts?: object) => sonnerToast.info(msg, opts),
  loading: (msg: string, opts?: object) => sonnerToast.loading(msg, opts),
  promise: sonnerToast.promise,
  dismiss: sonnerToast.dismiss,
};
