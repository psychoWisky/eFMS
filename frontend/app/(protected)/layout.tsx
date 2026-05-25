"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useIsAuthenticated, useAuthStore } from "@/stores/auth.store";
import { EFMSAppShell } from "@/components/layouts/app-shell";
import { SkeletonDashboard } from "@/components/loaders/skeleton";

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const isAuthenticated = useIsAuthenticated();
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
    if (hydrated && !isAuthenticated) router.replace("/login");
  }, [hydrated, isAuthenticated, router]);

  if (!hydrated) return <SkeletonDashboard />;
  if (!isAuthenticated) return <SkeletonDashboard />;

  return <EFMSAppShell>{children}</EFMSAppShell>;
}
