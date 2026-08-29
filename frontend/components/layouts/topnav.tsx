"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, ChevronDown, LogOut, Loader2, CheckCheck, FileText, Star, KeyRound, Repeat, Lock } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore, useUser, useActiveRole, type EfmsRole } from "@/stores/auth.store";
import { api } from "@/services/api";
import { toast } from "sonner";
import { cn, getInitials, formatDate } from "@/lib/utils";
import { ManageFavoritesDialog } from "@/components/shared/manage-favorites-dialog";
import { useMyProfiles, switchToProfile } from "@/hooks/use-my-profiles";

interface Notification { id: string; title: string; message: string | null; type: string; file_id: string | null; is_read: boolean; }

// Friendly labels for the roles this app shipped with; any other role
// (including every role Super Admin creates through Role Management) falls
// back to a prettified version of its raw name rather than rendering blank.
const ROLE_LABELS: Partial<Record<EfmsRole, string>> = {
  efms_officer: "eFMS Officer", efms_admin: "eFMS Admin", registrar: "Registrar",
  dispatch_officer: "Dispatch Officer", hod: "Head of Department",
  faculty: "Faculty", admin: "Admin", super_admin: "Super Admin",
};

function roleLabel(role: string): string {
  return ROLE_LABELS[role as EfmsRole] ?? role.split("_").map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" ");
}

export function EFMSTopNav({ sidebarWidth }: { sidebarWidth: number }) {
  const router = useRouter();
  const user = useUser();
  const activeRole = useActiveRole();
  const { clearAuth, refreshToken, setAuth } = useAuthStore();
  const qc = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  // Only fetched to populate the Switch Profile list — most users have no
  // project profiles at all (just their own original account), in which
  // case the section below simply doesn't render.
  const { data: myProfiles = [] } = useMyProfiles();
  const [showFavorites, setShowFavorites] = useState(false);

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

  const { mutateAsync: markOneRead } = useMutation({
    mutationFn: (nid: string) => api.patch(`/admin/notifications/${nid}/read`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  // Reading a notification and being allowed to open the file it refers to
  // are separate concerns — the notification always gets marked read, but
  // the file itself only opens if the backend's current-holder-only check
  // (GET /efms/files/{id}) still allows it. A user who has since forwarded
  // the file onward gets a clear toast instead of a stale, unauthorized open.
  async function handleNotificationClick(n: Notification) {
    setNotifOpen(false);
    if (!n.is_read) {
      try { await markOneRead(n.id); } catch { /* non-fatal — still try to open the file */ }
    }
    if (!n.file_id) return;
    try {
      await api.get(`/efms/files/${n.file_id}`);
      router.push(`/files/${n.file_id}`);
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 403) {
        toast.error("You don't have access to view this file. You are no longer the current holder.");
      } else {
        const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        toast.error(msg ?? "Could not open this file.");
      }
    }
  }

  const handleLogout = async () => {
    try { await api.post("/auth/logout", { refresh_token: refreshToken }); } catch { }
    clearAuth();
    // Drop all cached query data (e.g. /admin/users) so the next login
    // doesn't briefly see the previous user's stale, self-filtered results.
    qc.clear();
    router.replace("/login");
  };

  // Switching identity replaces the ENTIRE auth state with a fresh token
  // pair minted for the target profile's own users.id (POST /auth/
  // switch-profile) — from every other screen's perspective this is
  // indistinguishable from having logged in as that profile directly, so
  // every cached query keyed by the previous identity (My Files, Docket,
  // notifications, etc.) must be dropped exactly as handleLogout already
  // does, or a stale cross-identity result could briefly render.
  const handleSwitchProfile = async (profileId: string) => {
    if (profileId === user?.id) { setMenuOpen(false); return; }
    setSwitchingId(profileId);
    try {
      const { access_token, refresh_token, user: newUser } = await switchToProfile(profileId);
      setAuth(newUser, access_token, refresh_token);
      qc.clear();
      setMenuOpen(false);
      router.replace("/dashboard");
    } catch (err) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(msg ?? "Could not switch profile.");
    } finally {
      setSwitchingId(null);
    }
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
                      onClick={() => handleNotificationClick(n)}
                      className={cn("flex items-start gap-3 px-4 py-3 border-b border-gray-50 transition-colors cursor-pointer",
                        !n.is_read ? "bg-[#F0F7F7]" : "hover:bg-gray-50")}>
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
              <p className="text-xs text-[#4A5568]">{activeRole ? roleLabel(activeRole) : ""}</p>
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
                  <p className="text-xs text-[#0D6E6E] font-medium mt-0.5">{activeRole ? roleLabel(activeRole) : ""}</p>
                </div>
                {myProfiles.length > 1 && (
                  <div className="border-t border-[#D1D9E0] mt-1 py-1">
                    <p className="px-4 pt-1.5 pb-1 text-xs font-semibold text-[#9CA3AF] uppercase tracking-wide">Switch Profile</p>
                    {myProfiles.map((p) => {
                      const isCurrent = p.id === user?.id;
                      const isDisabled = p.is_active === false;
                      return (
                        <button
                          key={p.id}
                          disabled={isCurrent || isDisabled || switchingId === p.id}
                          onClick={() => handleSwitchProfile(p.id)}
                          title={isDisabled ? "This project profile is no longer active." : undefined}
                          className={cn(
                            "w-full flex items-center gap-3 px-4 py-2 text-sm text-left",
                            isCurrent ? "text-[#0D6E6E] font-semibold" : "text-[#1A1A2E]",
                            isDisabled ? "opacity-40 cursor-not-allowed" : "hover:bg-[#F0F7F7]"
                          )}
                        >
                          {switchingId === p.id ? <Loader2 size={14} className="animate-spin shrink-0" /> : isDisabled ? <Lock size={14} className="shrink-0" /> : <Repeat size={14} className="shrink-0" />}
                          <span className="truncate">{p.full_name}</span>
                          {isCurrent && <span className="ml-auto text-xs text-gray-400 shrink-0">Current</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="border-t border-[#D1D9E0] mt-1">
                  <button onClick={() => { setShowFavorites(true); setMenuOpen(false); }}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-base text-[#1A1A2E] hover:bg-[#F0F7F7]">
                    <Star size={15} /> Manage Favorite Recipients
                  </button>
                  {/* Available to every authenticated user regardless of
                      role — SUPER_ADMIN sees the same option here and can
                      only ever change their OWN password through it, same
                      as everyone else. */}
                  <button onClick={() => { setMenuOpen(false); router.push("/account/change-password"); }}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-base text-[#1A1A2E] hover:bg-[#F0F7F7]">
                    <KeyRound size={15} /> Change Password
                  </button>
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
      {showFavorites && <ManageFavoritesDialog onClose={() => setShowFavorites(false)} />}
    </header>
  );
}
