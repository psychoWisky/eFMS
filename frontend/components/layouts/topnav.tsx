"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, ChevronDown, LogOut, Loader2, CheckCheck, FileText, Star, KeyRound, Repeat, Lock, CheckCircle2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore, useUser, useActiveRole, type EfmsRole } from "@/stores/auth.store";
import { api } from "@/services/api";
import { toast } from "sonner";
import { cn, getInitials, formatDate } from "@/lib/utils";
import { ManageFavoritesDialog } from "@/components/shared/manage-favorites-dialog";
import { useMyProfiles, switchToProfile, switchToRole } from "@/hooks/use-my-profiles";

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

export function formatRoleTitle(roleName: string, estbName?: string | null, deptName?: string | null): string {
  const rLabel = roleLabel(roleName);
  const parts = [estbName, deptName, rLabel].filter(Boolean);
  return parts.length > 0 ? parts.join(" - ") : rLabel;
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

  // Switch role with organizational context (role + department + establishment)
  const handleSwitchRole = async (target: {
    role: string;
    department_id?: string | null;
    establishment_id?: string | null;
    user_role_id?: string | null;
  }) => {
    const isCurrent =
      target.role === activeRole &&
      (target.department_id ?? null) === (user?.department_id ?? null) &&
      (target.establishment_id ?? null) === (user?.establishment_id ?? null);
    if (isCurrent) { setMenuOpen(false); return; }

    const switchKey = target.user_role_id || `${target.role}:${target.establishment_id ?? ""}:${target.department_id ?? ""}`;
    setSwitchingId(`role:${switchKey}`);
    try {
      const { access_token, refresh_token, user: newUser } = await switchToRole({
        role: target.role,
        department_id: target.department_id,
        establishment_id: target.establishment_id,
        user_role_id: target.user_role_id,
      });
      setAuth(newUser, access_token, refresh_token);
      qc.clear();
      setMenuOpen(false);
      router.replace("/dashboard");
    } catch (err) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(msg ?? "Could not switch role.");
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
            <div className="hidden md:block text-left max-w-[260px]">
              <p className="text-sm font-semibold text-[#1A1A2E] leading-tight truncate">{user?.full_name ?? "User"}</p>
              <p className="text-xs text-[#0D6E6E] font-medium leading-tight mt-0.5 break-words whitespace-normal">
                {activeRole ? formatRoleTitle(activeRole, user?.establishment_name, user?.department_name) : ""}
              </p>
            </div>
            <ChevronDown size={14} className="text-[#9CA3AF] shrink-0" />
          </button>

          <AnimatePresence>
            {menuOpen && (
              <motion.div initial={{ opacity: 0, y: 8, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.95 }} transition={{ duration: 0.15 }}
                className="absolute right-0 top-full mt-2 w-[380px] max-w-[calc(100vw-2rem)] max-h-[85vh] overflow-y-auto bg-white rounded-2xl shadow-2xl border border-[#D1D9E0] py-1.5 z-50"
                onMouseLeave={() => setMenuOpen(false)}>
                <div className="px-4 py-3 border-b border-[#D1D9E0] bg-[#F8FAFC]">
                  <p className="text-sm font-bold text-[#1A1A2E] break-words">{user?.full_name}</p>
                  <p className="text-xs text-[#64748B] mt-0.5 break-all">{user?.email}</p>
                  <div className="mt-2.5 pt-2 border-t border-gray-200">
                    <span className="text-[10px] uppercase font-bold tracking-wider text-gray-500 block">Current Active Role</span>
                    <p className="text-xs text-[#0D6E6E] font-semibold mt-0.5 break-words whitespace-normal leading-relaxed">
                      {activeRole ? formatRoleTitle(activeRole, user?.establishment_name, user?.department_name) : "—"}
                    </p>
                  </div>
                </div>
                {(user?.held_roles?.length ?? 0) > 1 && (
                  <div className="border-t border-[#D1D9E0] mt-1 pt-2 pb-1">
                    <p className="px-4 pb-1.5 text-[11px] font-bold text-[#64748B] uppercase tracking-wider">Switch Role</p>
                    <div className="space-y-1 px-2">
                      {(user?.held_roles ?? []).map((r) => {
                        const isCurrent =
                          r.role === activeRole &&
                          (r.department_id ?? null) === (user?.department_id ?? null) &&
                          (r.establishment_id ?? null) === (user?.establishment_id ?? null);
                        const switchKey = r.id || `${r.role}:${r.establishment_id ?? ""}:${r.department_id ?? ""}`;
                        const busy = switchingId === `role:${switchKey}`;
                        const rName = roleLabel(r.role);
                        const orgParts = [r.establishment_name, r.department_name].filter(Boolean);

                        return (
                          <button
                            key={switchKey}
                            disabled={isCurrent || busy}
                            onClick={() => handleSwitchRole({
                              role: r.role,
                              department_id: r.department_id,
                              establishment_id: r.establishment_id,
                              user_role_id: r.id,
                            })}
                            className={cn(
                              "w-full flex items-start gap-3 p-3 rounded-xl text-left transition-all border",
                              isCurrent
                                ? "bg-emerald-50/80 border-emerald-300 text-emerald-950 shadow-xs"
                                : "hover:bg-[#F0F7F7] border-transparent text-[#1A1A2E]",
                              "disabled:cursor-default",
                            )}
                          >
                            <div className="shrink-0 mt-0.5">
                              {busy ? (
                                <Loader2 size={16} className="animate-spin text-[#0D6E6E]" />
                              ) : isCurrent ? (
                                <CheckCircle2 size={16} className="text-emerald-600" />
                              ) : (
                                <Repeat size={16} className="text-[#9CA3AF]" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className={cn("text-sm leading-snug break-words whitespace-normal", isCurrent ? "font-bold text-emerald-950" : "font-semibold text-gray-900")}>
                                {rName}
                              </p>
                              {orgParts.length > 0 && (
                                <p className="text-xs text-gray-600 mt-0.5 break-words whitespace-normal leading-relaxed">
                                  {orgParts.join(" · ")}
                                </p>
                              )}
                              {isCurrent ? (
                                <span className="inline-flex items-center gap-1.5 mt-2 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-600 text-white shadow-xs">
                                  <span className="w-1.5 h-1.5 rounded-full bg-white"></span>
                                  Currently Obtained Role (Active)
                                </span>
                              ) : (
                                <span className="inline-block mt-1 text-[11px] text-[#0D6E6E] font-semibold hover:underline">
                                  Click to switch to this role
                                </span>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {myProfiles.length > 1 && (
                  <div className="border-t border-[#D1D9E0] mt-1 pt-1.5 pb-1">
                    <p className="px-4 pb-1 text-[11px] font-semibold text-[#9CA3AF] uppercase tracking-wider">Switch Profile</p>
                    {myProfiles.map((p) => {
                      const isCurrent = p.id === user?.id;
                      const isDisabled = p.is_active === false;
                      const piLabel = p.project_number ? `PI${p.project_number}` : null;
                      // Full project name, no truncation. For a project profile
                      // the primary line is "PI3 · Soil Health Survey"; for the
                      // own account it's the person's name.
                      const primary = piLabel
                        ? [piLabel, p.project_name].filter(Boolean).join(" · ")
                        : p.full_name;
                      return (
                        <button
                          key={p.id}
                          disabled={isCurrent || isDisabled || switchingId === p.id}
                          onClick={() => handleSwitchProfile(p.id)}
                          className={cn(
                            "w-full flex items-start gap-3 px-4 py-2.5 text-sm text-left",
                            isCurrent ? "text-[#0D6E6E] font-semibold bg-[#F0F7F7]" : "text-[#1A1A2E]",
                            isDisabled ? "opacity-40 cursor-not-allowed" : "hover:bg-[#F0F7F7]",
                          )}
                        >
                          <span className="shrink-0 mt-0.5">
                            {switchingId === p.id ? <Loader2 size={15} className="animate-spin" /> : isDisabled ? <Lock size={15} className="text-[#9CA3AF]" /> : <Repeat size={15} className="text-[#9CA3AF]" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block break-words">{primary}</span>
                            <span className="block text-xs text-[#9CA3AF] font-normal">
                              {piLabel ? (isDisabled ? "Project profile · inactive" : "Project profile") : "Your account"}
                            </span>
                          </span>
                          {isCurrent && <span className="ml-auto text-xs text-gray-400 shrink-0 self-center">Current</span>}
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
