"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, ChevronDown, LogOut, Loader2, CheckCheck, FileText } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore, useUser, useActiveRole, type EfmsRole } from "@/stores/auth.store";
import { api } from "@/services/api";
import { toast } from "sonner";
import { cn, getInitials, formatDate } from "@/lib/utils";

interface Notification { id: string; title: string; message: string | null; type: string; file_id: string | null; is_read: boolean; }

const ROLE_LABELS: Record<EfmsRole, string> = {
  efms_officer: "eFMS Officer", efms_admin: "eFMS Admin", registrar: "Registrar",
  dispatch_officer: "Dispatch Officer", hod: "Head of Department",
  faculty: "Faculty", admin: "Admin", super_admin: "Super Admin",
};

export function EFMSTopNav({ sidebarWidth }: { sidebarWidth: number }) {
  const router = useRouter();
  const user = useUser();
  const activeRole = useActiveRole();
  const { clearAuth } = useAuthStore();
  const qc = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);

  const { data: notifications = [] } = useQuery<Notification[]>({
    queryKey: ["notifications"],
    queryFn: async () => (await api.get("/admin/notifications")).data,
    refetchInterval: 30000,
  });

  const unread = notifications.filter((n) => !n.is_read).length;

  const { mutate: markAllRead } = useMutation({
    mutationFn: () => api.patch("/admin/notifications/read-all", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const handleLogout = async () => {
    try { await api.post("/auth/logout"); } catch { }
    clearAuth();
    router.replace("/login");
  };

  return (
    <header
      className="fixed top-0 right-0 h-16 bg-white border-b border-[#D1D9E0] z-20 flex items-center justify-between px-6"
      style={{ left: sidebarWidth, transition: "left .2s ease" }}
    >
      <div className="flex items-center gap-3">
        <div className="w-2 h-2 rounded-full bg-[#0D6E6E]" />
        <span className="text-base font-semibold text-[#1A1A2E]">AVFU Electronic File Management System</span>
      </div>

      <div className="flex items-center gap-3">
        {/* Notification Bell */}
        <div className="relative">
          <button onClick={() => { setNotifOpen((o) => !o); setMenuOpen(false); }}
            className="relative w-10 h-10 rounded-xl flex items-center justify-center text-[#4A5568] hover:bg-[#F0F7F7] transition-colors">
            <Bell size={20} />
            {unread > 0 && (
              <span className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </button>

          <AnimatePresence>
            {notifOpen && (
              <motion.div initial={{ opacity: 0, y: 8, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.95 }} transition={{ duration: 0.15 }}
                className="absolute right-0 top-full mt-2 w-80 bg-white rounded-xl shadow-2xl border border-[#D1D9E0] z-50 overflow-hidden"
                onMouseLeave={() => setNotifOpen(false)}>
                <div className="flex items-center justify-between px-4 py-3 border-b border-[#D1D9E0]">
                  <p className="text-base font-bold text-[#1A1A2E]">Notifications {unread > 0 && <span className="text-sm text-red-500">({unread} new)</span>}</p>
                  {unread > 0 && (
                    <button onClick={() => markAllRead()} className="text-sm text-[#0D6E6E] hover:underline flex items-center gap-1">
                      <CheckCheck size={13} /> Mark all read
                    </button>
                  )}
                </div>
                <div className="max-h-80 overflow-y-auto">
                  {notifications.length === 0 ? (
                    <div className="py-10 text-center text-gray-400 text-sm">No notifications</div>
                  ) : notifications.map((n) => (
                    <div key={n.id}
                      onClick={() => { if (n.file_id) { router.push(`/files/${n.file_id}`); setNotifOpen(false); } }}
                      className={cn("flex items-start gap-3 px-4 py-3 border-b border-gray-50 transition-colors",
                        !n.is_read ? "bg-[#F0F7F7]" : "hover:bg-gray-50",
                        n.file_id && "cursor-pointer")}>
                      <div className={cn("w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5",
                        !n.is_read ? "bg-[#0D6E6E]" : "bg-gray-100")}>
                        <FileText size={14} className={!n.is_read ? "text-white" : "text-gray-400"} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={cn("text-sm leading-snug", !n.is_read ? "font-semibold text-gray-900" : "text-gray-700")}>{n.title}</p>
                        {n.message && <p className="text-xs text-gray-500 mt-0.5 truncate">{n.message}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* User Menu */}
        <div className="relative">
          <button onClick={() => { setMenuOpen((o) => !o); setNotifOpen(false); }}
            className="flex items-center gap-2.5 py-1.5 px-3 rounded-xl hover:bg-[#F0F7F7] transition-colors">
            <div className="w-8 h-8 rounded-full bg-[#0D6E6E] flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
              {user ? getInitials(user.full_name) : "?"}
            </div>
            <div className="hidden md:block text-left">
              <p className="text-sm font-semibold text-[#1A1A2E] leading-tight">{user?.full_name ?? "User"}</p>
              <p className="text-xs text-[#4A5568]">{activeRole ? ROLE_LABELS[activeRole] : ""}</p>
            </div>
            <ChevronDown size={14} className="text-[#9CA3AF]" />
          </button>

          <AnimatePresence>
            {menuOpen && (
              <motion.div initial={{ opacity: 0, y: 8, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.95 }} transition={{ duration: 0.15 }}
                className="absolute right-0 top-full mt-2 w-52 bg-white rounded-xl shadow-2xl border border-[#D1D9E0] py-1 z-50"
                onMouseLeave={() => setMenuOpen(false)}>
                <div className="px-4 py-3 border-b border-[#D1D9E0]">
                  <p className="text-sm font-semibold text-[#1A1A2E]">{user?.full_name}</p>
                  <p className="text-xs text-[#4A5568] mt-0.5">{user?.email}</p>
                  <p className="text-xs text-[#0D6E6E] font-medium mt-0.5">{activeRole ? ROLE_LABELS[activeRole] : ""}</p>
                </div>
                <div className="border-t border-[#D1D9E0] mt-1">
                  <button onClick={handleLogout}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-base text-red-600 hover:bg-red-50">
                    <LogOut size={15} /> Sign Out
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </header>
  );
}
