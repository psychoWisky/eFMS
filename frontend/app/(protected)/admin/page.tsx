"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AdminPanel } from "@/modules/admin/admin-panel";
import { useActiveRole } from "@/stores/auth.store";

// The Admin Panel is for the Super Admin role only — anyone else who opens
// /admin (old link, typed URL) is sent back to their Dashboard.
export default function AdminRoute() {
  const router = useRouter();
  const isSuperAdmin = useActiveRole() === "super_admin";
  useEffect(() => {
    if (!isSuperAdmin) router.replace("/dashboard");
  }, [isSuperAdmin, router]);
  if (!isSuperAdmin) return null;
  return <AdminPanel />;
}
