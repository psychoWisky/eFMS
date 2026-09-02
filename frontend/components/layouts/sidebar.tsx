"use client";
import { motion, AnimatePresence } from "framer-motion";
import { usePathname, useRouter } from "next/navigation";
import { LayoutDashboard, ShieldCheck, PanelLeftClose, PanelLeftOpen, Search, History } from "lucide-react";
import { useActiveRole } from "@/stores/auth.store";
import { guardedNavigate } from "@/hooks/use-unsaved-changes-guard";
import { cn } from "@/lib/utils";
import Image from "next/image";

// All non-SUPER_ADMIN roles are equal, ordinary eFMS roles — including any
// role Super Admin creates through Role Management. Normal eFMS workflow
// pages are therefore available to every role except super_admin (which
// only sees Admin Panel), rather than an enumerated legacy-role list.
interface NavItem { label: string; icon: React.ElementType; href: string; audience: "normal" | "super_admin"; }

const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard",    icon: LayoutDashboard, href: "/dashboard", audience: "normal" },
  { label: "Search Files", icon: Search,          href: "/search",    audience: "normal" },
  { label: "Tracking History", icon: History,     href: "/tracking",  audience: "normal" },
  { label: "Admin Panel",  icon: ShieldCheck,     href: "/admin",     audience: "super_admin" },
];

interface SidebarProps { collapsed: boolean; canToggle: boolean; onToggle: () => void; }

export function EFMSSidebar({ collapsed, canToggle, onToggle }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const role = useActiveRole();
  const visible = NAV_ITEMS.filter((item) =>
    !role ? true : item.audience === "super_admin" ? role === "super_admin" : role !== "super_admin"
  );

  return (
    <motion.aside
      animate={{ width: collapsed ? 76 : 248 }}
      transition={{ duration: 0.2, ease: "easeInOut" }}
      className="fixed left-0 top-0 h-full bg-white border-r border-gray-200 z-30 flex flex-col overflow-hidden"
      style={{ boxShadow: "2px 0 8px rgba(0,0,0,.04)" }}
    >
      <div className={cn("flex items-center h-16 border-b border-gray-200 flex-shrink-0", collapsed ? "justify-center px-2" : "gap-3 px-4")}>
        <div className="w-9 h-9 rounded-xl overflow-hidden flex items-center justify-center flex-shrink-0 bg-white">
          <Image
            src="/avfu_logo.png"
            alt="AVFU Logo"
            width={36}
            height={36}
            className="object-contain w-full h-full"
          />
        </div>
        <AnimatePresence>
          {!collapsed && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <p className="text-base font-bold text-[#1A1A2E]">eFMS</p>
              <p className="text-xs text-gray-500">File Management</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <nav className={cn("flex-1 overflow-y-auto py-3", collapsed ? "px-2" : "px-3")}>
        {visible.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <a key={item.href} href={item.href} title={collapsed ? item.label : undefined}
              onClick={(e) => {
                e.preventDefault();
                guardedNavigate(() => router.push(item.href));
              }}
              className={cn("group flex items-center rounded-xl mb-1 transition-all relative",
                collapsed ? "flex-col gap-1 px-1 py-2.5 justify-center" : "gap-3 px-3 py-3",
                active ? "bg-[#E6F4F4] text-[#0D6E6E] font-semibold" : "text-gray-500 hover:bg-gray-50 hover:text-[#0D6E6E]")}>
              {active && !collapsed && <motion.div layoutId="active-pill" className="absolute left-0 top-1 bottom-1 w-1 rounded-full bg-[#0D6E6E]" />}
              <item.icon size={collapsed ? 22 : 20} className={cn("flex-shrink-0", active ? "text-[#0D6E6E]" : "text-gray-400 group-hover:text-[#0D6E6E]")} />
              {collapsed ? (
                <span className={cn("text-[10px] leading-tight text-center truncate w-full", active ? "text-[#0D6E6E] font-semibold" : "text-gray-400 group-hover:text-[#0D6E6E]")}>
                  {item.label.split(" ")[0]}
                </span>
              ) : (
                <AnimatePresence>
                  <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-base truncate">
                    {item.label}
                  </motion.span>
                </AnimatePresence>
              )}
            </a>
          );
        })}
      </nav>

      {canToggle && (
        <div className={cn("pb-4 flex-shrink-0", collapsed ? "px-2" : "px-3")}>
          <button
            onClick={onToggle}
            aria-label={collapsed ? "Expand menu" : "Collapse menu"}
            className={cn(
              "w-full flex items-center rounded-xl border border-[#0D6E6E]/25 bg-[#F0F7F7] text-[#0D6E6E] font-semibold hover:bg-[#E6F4F4] transition-colors",
              collapsed ? "flex-col gap-1 py-2.5 px-1" : "gap-2 justify-center py-2.5 px-3"
            )}
          >
            {collapsed
              ? <><PanelLeftOpen size={20} /><span className="text-[10px] leading-none">Expand</span></>
              : <><PanelLeftClose size={16} /><span className="text-sm">Collapse menu</span></>}
          </button>
        </div>
      )}
    </motion.aside>
  );
}
