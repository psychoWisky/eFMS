"use client";
// The authenticated person's original profile + every project profile
// (PI profile) assigned to them — see Project-Specific User Profiles.
// Switching never mutates the JWT in place: it fetches a completely fresh
// access+refresh token pair for the target profile's own users.id from
// POST /auth/switch-profile, then replaces the whole auth state via the
// existing setAuth — every other screen (My Files, Docket, notesheet
// editor, attachments) needs no changes at all, since they already just
// operate on whichever user the current token represents.
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useAuthStore, type AuthUser } from "@/stores/auth.store";

export function useMyProfiles() {
  const accessToken = useAuthStore((s) => s.accessToken);
  return useQuery<AuthUser[]>({
    queryKey: ["my-profiles"],
    queryFn: async () => (await api.get("/auth/my-profiles")).data,
    enabled: !!accessToken,
  });
}

export async function switchToProfile(profileUserId: string) {
  const res = await api.post("/auth/switch-profile", { profile_user_id: profileUserId });
  return res.data as { access_token: string; refresh_token: string; user: AuthUser };
}
