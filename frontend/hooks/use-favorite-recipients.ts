"use client";
// Single source of truth for the favorite-recipient toggle mutations and the
// favorites-first grouping used by every recipient picker (New File, Draft
// Edit, Forward, Manage Favorite Recipients). Reuses the same GET /admin/users
// response every picker already fetches — no separate "list favorites" call.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { SearchableSelectGroup, SearchableSelectOption } from "@/components/shared/searchable-select";

export interface FavoritableUser {
  id: string;
  full_name: string;
  designation?: string | null;
  department_name?: string | null;
  employee_code?: string | null;
  is_favorite?: boolean;
}

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

  function personLabel(u: FavoritableUser): string {
    return u.employee_code ? `${u.full_name} (${u.employee_code})` : u.full_name;
  }

  /** Partition an already-fetched user list into Favorite / All Recipients
   * groups for SearchableSelect — grouping stays client-side; the backend's
   * alphabetical order (order_by(User.first_name)) is preserved within each
   * group since the input array is never re-sorted here. */
  function buildGroups(
    users: FavoritableUser[],
    label: (u: FavoritableUser) => string = personLabel,
  ): SearchableSelectGroup[] {
    const favorites: SearchableSelectOption[] = [];
    const others: SearchableSelectOption[] = [];
    for (const u of users) {
      (u.is_favorite ? favorites : others).push({ value: u.id, label: label(u) });
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
