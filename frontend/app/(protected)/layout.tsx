"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useIsAuthenticated, useAuthStore, useMustChangePassword, useUser } from "@/stores/auth.store";
import { EFMSAppShell } from "@/components/layouts/app-shell";
import { SkeletonDashboard } from "@/components/loaders/skeleton";

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const retired = !!useUser()?.is_retired;
  const isAuthenticated = useIsAuthenticated();
  const mustChangePassword = useMustChangePassword();
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    // Mark hydrated immediately if already done, else wait for finish
    if (useAuthStore.persist.hasHydrated()) {
      setHydrated(true);
    } else {
      const unsub = useAuthStore.persist.onFinishHydration(() => setHydrated(true));
      return unsub;
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (!isAuthenticated) { router.replace("/login"); return; }
    if (mustChangePassword) { router.replace("/change-password"); return; }
    // A retired person works from the Dashboard (Docket) and the files in it.
    if (retired && !(pathname === "/dashboard" || pathname.startsWith("/files/") || pathname.startsWith("/account"))) {
      router.replace("/dashboard");
    }
  }, [hydrated, isAuthenticated, mustChangePassword, retired, pathname, router]);

  if (!hydrated) return <SkeletonDashboard />;
  if (!isAuthenticated) return <SkeletonDashboard />;
  if (mustChangePassword) return <SkeletonDashboard />;

  return <EFMSAppShell>{children}</EFMSAppShell>;
}
