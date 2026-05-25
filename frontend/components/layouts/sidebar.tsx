"use client";
import { motion, AnimatePresence } from "framer-motion";
import { usePathname } from "next/navigation";
import { LayoutDashboard, ShieldCheck, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useActiveRole, type EfmsRole } from "@/stores/auth.store";
import { cn } from "@/lib/utils";

interface NavItem { label: string; icon: React.ElementType; href: string; roles: EfmsRole[]; }

const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard",    icon: LayoutDashboard, href: "/dashboard", roles: ["efms_officer","efms_admin","registrar","dispatch_officer","hod","faculty","student"] },
  { label: "Search Files", icon: Search,          href: "/search",    roles: ["efms_officer","efms_admin","registrar","dispatch_officer","hod","faculty","student"] },
  { label: "Admin Panel",  icon: ShieldCheck,     href: "/admin",     roles: ["admin","super_admin"] },
];

interface SidebarProps { collapsed: boolean; onToggle: () => void; }

export function EFMSSidebar({ collapsed, onToggle }: SidebarProps) {
  const pathname = usePathname();
  const role = useActiveRole();
  const visible = NAV_ITEMS.filter((item) => !role || item.roles.includes(role));

  return (
    <motion.aside
      animate={{ width: collapsed ? 64 : 220 }}
      transition={{ duration: 0.2, ease: "easeInOut" }}
      className="fixed left-0 top-0 h-full bg-white border-r border-gray-200 z-30 flex flex-col overflow-hidden"
      style={{ boxShadow: "2px 0 8px rgba(0,0,0,.04)" }}
    >
      <div className="flex items-center gap-3 px-4 h-16 border-b border-gray-200 flex-shrink-0">
        <div className="w-9 h-9 rounded-xl bg-[#0D6E6E] flex items-center justify-center flex-shrink-0">
          <span className="text-white font-bold text-sm">e</span>
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

      <nav className="flex-1 overflow-y-auto py-3 px-2">
        {visible.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <a key={item.href} href={item.href} title={collapsed ? item.label : undefined}
              className={cn("group flex items-center gap-3 px-3 py-3 rounded-xl mb-0.5 transition-all relative",
                active ? "bg-[#E6F4F4] text-[#0D6E6E] font-semibold" : "text-gray-500 hover:bg-gray-50 hover:text-[#0D6E6E]")}>
              {active && <motion.div layoutId="active-pill" className="absolute left-0 top-1 bottom-1 w-1 rounded-full bg-[#0D6E6E]" />}
              <item.icon size={20} className={cn("flex-shrink-0", active ? "text-[#0D6E6E]" : "text-gray-400 group-hover:text-[#0D6E6E]")} />
              <AnimatePresence>
                {!collapsed && (
                  <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-base truncate">
                    {item.label}
                  </motion.span>
                )}
              </AnimatePresence>
            </a>
          );
        })}
      </nav>

      <div className="px-2 pb-4 flex-shrink-0">
        <button onClick={onToggle}
          className="w-full flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl text-sm text-gray-500 hover:bg-gray-50 hover:text-[#0D6E6E] transition-colors">
          {collapsed ? <ChevronRight size={16} /> : <><ChevronLeft size={16} /><span>Collapse</span></>}
        </button>
      </div>
    </motion.aside>
  );
}
