"use client";
import { FocAdminPage } from "@/modules/foc/foc-admin";
import { useFocMe } from "@/lib/foc";
export default function Page() {
  const { data: me } = useFocMe();
  if (!me?.is_super_admin) return <p className="text-center text-gray-500 py-20">FOC Setup is for the Super Admin.</p>;
  return <FocAdminPage />;
}
