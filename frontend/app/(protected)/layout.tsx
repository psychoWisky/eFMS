"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useIsAuthenticated, useAuthStore, useMustChangePassword } from "@/stores/auth.store";
import { EFMSAppShell } from "@/components/layouts/app-shell";
import { SkeletonDashboard } from "@/components/loaders/skeleton";

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
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
    if (mustChangePassword) router.replace("/change-password");
  }, [hydrated, isAuthenticated, mustChangePassword, router]);

  if (!hydrated) return <SkeletonDashboard />;
  if (!isAuthenticated) return <SkeletonDashboard />;
  if (mustChangePassword) return <SkeletonDashboard />;

  return <EFMSAppShell>{children}</EFMSAppShell>;
}
