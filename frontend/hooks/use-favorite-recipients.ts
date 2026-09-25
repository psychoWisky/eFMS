"use client";
// Single source of truth for the favorite-recipient toggle mutations and the
// favorites-first grouping used by every recipient picker (New File, Draft
// Edit, Forward, Manage Favorite Recipients). Reuses the same GET /admin/users
// response every picker already fetches — no separate "list favorites" call.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { truncate } from "@/lib/utils";
import type { SearchableSelectGroup, SearchableSelectOption } from "@/components/shared/searchable-select";

export interface FavoritableUser {
  id: string;
  full_name: string;
  designation?: string | null;
  department_name?: string | null;
  employee_code?: string | null;
  is_favorite?: boolean;
  // Set only for a project-specific profile (e.g. "User A PI74") — see
  // Project-Specific User Profiles. Never another label for the same
  // person's original account; a genuinely separate, selectable recipient.
  is_project_profile?: boolean;
  project_number?: string | null;
  project_name?: string | null;
  // The specific role this recipient entry targets (multi-role users). The
  // backend returns one entry per role; the picker sends `<id>::<role>` so
  // Forward can route the file to that role's workspace.
  role?: string | null;
  // Set only when the recipient holds `role` in more than one establishment/
  // department: the exact user_roles row, and its "<estb> · <dept>" label.
  user_role_id?: string | null;
  role_context?: string | null;
}

/** A recipient-picker option value is "<userId>::<role>", or
 * "<userId>::<role>::<userRoleId>" when the person holds that role in
 * several contexts. Split it back for the Forward call. `role` is undefined
 * for a legacy value with no "::". */
export function splitRecipientValue(v: string): { userId: string; role?: string; userRoleId?: string } {
  const [userId, role, userRoleId] = v.split("::");
  return { userId, role: role || undefined, userRoleId: userRoleId || undefined };
}

/** Build the picker option value that matches a recipient saved on a draft
 * (person + optional role + optional exact role row). Prefers the exact
 * role row, then the role name, then the person's first entry — so a saved
 * draft still pre-selects correctly if the person's roles changed since.
 * Returns "" when the person isn't in `users`. */
export function resolveRecipientValue(
  users: FavoritableUser[],
  userId: string | null | undefined,
  role?: string | null,
  userRoleId?: string | null,
): string {
  if (!userId) return "";
  const entries = users.filter((u) => u.id === userId);
  const hit =
    (userRoleId && entries.find((u) => u.user_role_id === userRoleId)) ||
    (role && entries.find((u) => u.role === role)) ||
    entries[0];
  if (!hit) return "";
  if (!hit.role) return hit.id;
  return hit.user_role_id ? `${hit.id}::${hit.role}::${hit.user_role_id}` : `${hit.id}::${hit.role}`;
}

const prettyRoleName = (name: string) =>
  ({ efms_officer: "eFMS Officer", efms_admin: "eFMS Admin" } as Record<string, string>)[name]
  ?? name.split("_").map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" ");

// Any query whose key starts with "admin-users" — matches every recipient
// picker's query key (["admin-users"], ["admin-users", officeId, sectionId]),
// so one invalidation/optimistic update reaches all of them at once.
const ADMIN_USERS_KEY = ["admin-users"];

export function useFavoriteRecipients() {
  const qc = useQueryClient();

  function flip(recipientId: string, value: boolean) {
    qc.setQueriesData<FavoritableUser[]>({ queryKey: ADMIN_USERS_KEY }, (old) =>
      old?.map((u) => (u.id === recipientId ? { ...u, is_favorite: value } : u))
    );
  }

  const addFavorite = useMutation({
    mutationFn: (recipientId: string) => api.post(`/admin/favorites/${recipientId}`),
    onMutate: (recipientId: string) => flip(recipientId, true),
    onSettled: () => qc.invalidateQueries({ queryKey: ADMIN_USERS_KEY }),
  });

  const removeFavorite = useMutation({
    mutationFn: (recipientId: string) => api.delete(`/admin/favorites/${recipientId}`),
    onMutate: (recipientId: string) => flip(recipientId, false),
    onSettled: () => qc.invalidateQueries({ queryKey: ADMIN_USERS_KEY }),
  });

  function toggleFavorite(recipientId: string, currentlyFavorite: boolean) {
    if (currentlyFavorite) removeFavorite.mutate(recipientId);
    else addFavorite.mutate(recipientId);
  }

  // The "name" half of the structured search split (searchName/searchRole
  // on SearchableSelectOption — see that component). Deliberately includes
  // employee_code and, for a PI profile, the project name too, so
  // searching either still finds the right person — only the role name
  // itself is excluded here, since that's the OTHER half of the split
  // (searchRole below) and must narrow results, not just be one more
  // thing a name-shaped query happens to match.
  function searchNameFor(u: FavoritableUser): string {
    if (u.is_project_profile) {
      const pi = `PI${u.project_number ?? ""}`;
      const person = u.full_name.replace(new RegExp(`\\s*${pi}\\s*$`), "").trim() || u.full_name;
      return [person, pi, u.project_name].filter(Boolean).join(" ");
    }
    return [u.full_name, u.employee_code].filter(Boolean).join(" ");
  }

  function personLabel(u: FavoritableUser): string {
    if (u.is_project_profile) {
      // A PI profile's full_name is "<person> PI<n>". Rebuild the label so it
      // reads "<person> · PI<n> · <project>" without repeating "PI<n>".
      const pi = `PI${u.project_number ?? ""}`;
      const person = u.full_name.replace(new RegExp(`\\s*${pi}\\s*$`), "").trim() || u.full_name;
      const project = u.project_name ? truncate(u.project_name, 36) : "";
      return project ? `${person} · ${pi} · ${project}` : `${person} · ${pi}`;
    }
    const base = u.employee_code ? `${u.full_name} (${u.employee_code})` : u.full_name;
    // Multi-role recipient: the list has one entry per role — spell out
    // which role this entry routes to.
    if (!u.role) return base;
    const role = prettyRoleName(u.role);
    return u.role_context ? `${base} — ${role} (${u.role_context})` : `${base} — ${role}`;
  }

  /** Partition an already-fetched user list into Favorite / All Recipients
   * groups for SearchableSelect — grouping stays client-side; the backend's
   * alphabetical order (order_by(User.first_name)) is preserved within each
   * group since the input array is never re-sorted here. The option value
   * is "<id>::<role>" so a multi-role recipient's per-role entries stay
   * distinct and Forward can recover the target role. */
  function buildGroups(
    users: FavoritableUser[],
    label: (u: FavoritableUser) => string = personLabel,
  ): SearchableSelectGroup[] {
    const favorites: SearchableSelectOption[] = [];
    const others: SearchableSelectOption[] = [];
    for (const u of users) {
      const value = resolveRecipientValue([u], u.id, u.role, u.user_role_id);
      // Structured search: typing a name matches every role-entry this
      // person has (they all share the same searchName); typing a role
      // name narrows down to only the entries actually stamped with that
      // role — see SearchableSelect's matches() for how these combine.
      const option: SearchableSelectOption = {
        value, label: label(u),
        searchName: searchNameFor(u),
        searchRole: u.role ? prettyRoleName(u.role) : undefined,
      };
      (u.is_favorite ? favorites : others).push(option);
    }
    const groups: SearchableSelectGroup[] = [];
    if (favorites.length > 0) groups.push({ label: "⭐ Favorite Recipients", options: favorites });
    groups.push({ label: "All Recipients", options: others });
    return groups;
  }

  return {
    toggleFavorite,
    buildGroups,
    personLabel,
    isToggling: addFavorite.isPending || removeFavorite.isPending,
  };
}
