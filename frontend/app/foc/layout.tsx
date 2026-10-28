"use client";
// FOC (Fixation of Ceiling) — a separate area inside eFMS: same sign-in and
// accounts, its own header, navigation and docket.
import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft, Inbox, FileSpreadsheet, History, Settings2, Loader2, ShieldAlert } from "lucide-react";
import { useAuthStore, useIsAuthenticated, useMustChangePassword, useUser } from "@/stores/auth.store";
import { FOC_ENABLED, useFocMe } from "@/lib/foc";
import { cn } from "@/lib/utils";

export default function FocLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const user = useUser();
  const isAuthenticated = useIsAuthenticated();
  const mustChangePassword = useMustChangePassword();
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
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
    // FOC is not released yet — nobody lands here.
    if (!FOC_ENABLED) { router.replace("/dashboard"); return; }
    if (mustChangePassword) { router.replace("/change-password"); return; }
    // A retired person keeps their eFMS Docket only.
    if (user?.is_retired) router.replace("/dashboard");
  }, [hydrated, isAuthenticated, mustChangePassword, user?.is_retired, router]);

  const ready = FOC_ENABLED && hydrated && isAuthenticated && !mustChangePassword && !user?.is_retired;
  const { data: me, isLoading, isError } = useFocMe(ready);

  // The Super Admin sets FOC up; the docket is for in-charges and officers.
  const home = me && !me.has_docket && me.is_super_admin ? "/foc/admin" : "/foc";
  useEffect(() => {
    if (me && !me.has_docket && me.is_super_admin && pathname === "/foc") router.replace("/foc/admin");
  }, [me, pathname, router]);

  const nav = [
    { href: "/foc", label: "FOC Docket", icon: Inbox, show: !!me?.has_docket },
    { href: "/foc/mine", label: "My FOCs", icon: FileSpreadsheet, show: !!me?.is_incharge },
    { href: "/foc/history", label: "History", icon: History, show: !!me && me.officer_roles.length > 0 },
    { href: "/foc/admin", label: "FOC Setup", icon: Settings2, show: !!me?.is_super_admin },
  ].filter((n) => n.show);

  const isActive = (href: string) => (href === "/foc" ? pathname === "/foc" : pathname.startsWith(href));

  return (
    <div className="min-h-screen bg-[#F5F7FA]">
      <header className="sticky top-0 z-30 bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 h-16 flex items-center gap-4">
          <Link href={home} className="flex items-center gap-3 shrink-0">
            <Image src="/avfu_logo.png" alt="AVFU" width={36} height={36} className="rounded-full" />
            <div className="leading-tight">
              <p className="text-base font-bold text-[#0A5757]">FOC</p>
              <p className="text-[11px] text-gray-500 -mt-0.5">Fixation of Ceiling</p>
            </div>
          </Link>
          <nav className="flex items-center gap-1 ml-4 overflow-x-auto">
            {nav.map(({ href, label, icon: Icon }) => (
              <Link key={href} href={href}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition-colors",
                  isActive(href) ? "bg-[#E6F4F4] text-[#0D6E6E]" : "text-gray-600 hover:bg-gray-100",
                )}>
                <Icon size={16} /> {label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <div className="hidden md:block text-right leading-tight">
              <p className="text-sm font-semibold text-gray-800">{user?.full_name}</p>
              <p className="text-xs text-gray-500">{me?.officer_titles.join(" · ") || (me?.is_incharge ? "FOC In-charge" : me?.is_super_admin ? "Super Admin" : "")}</p>
            </div>
            <Link href="/dashboard"
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold border border-gray-200 text-gray-700 hover:bg-gray-50">
              <ArrowLeft size={15} /> eFMS
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6">
        {!ready || isLoading ? (
          <div className="flex items-center justify-center py-24 gap-3 text-gray-400"><Loader2 className="animate-spin" /> Loading…</div>
        ) : isError || !me?.has_access ? (
          <div className="max-w-lg mx-auto mt-16 bg-white border border-gray-200 rounded-2xl p-8 text-center">
            <ShieldAlert className="mx-auto text-amber-500 mb-3" size={36} />
            <h1 className="text-lg font-bold text-gray-900">You are not part of FOC</h1>
            <p className="text-sm text-gray-500 mt-2">
              FOC is used by FOC in-charges, the DDOs, the Assistant Comptroller, the Finance Officer and the
              Vice Chancellor. Ask the Super Admin if you should have access.
            </p>
            <Link href="/dashboard" className="inline-block mt-5 text-sm font-semibold text-[#0D6E6E] hover:underline">← Back to eFMS</Link>
          </div>
        ) : children}
      </main>
    </div>
  );
}
