"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useActiveRole } from "@/stores/auth.store";
import { EFMSDashboard } from "@/modules/dashboard/efms-dashboard";

export default function DashboardPage() {
  const role = useActiveRole();
  const router = useRouter();

  useEffect(() => {
    if (role && ["admin", "super_admin"].includes(role)) {
      router.replace("/admin");
    }
  }, [role, router]);

  if (role && ["admin", "super_admin"].includes(role)) return null;
  return <EFMSDashboard />;
}
