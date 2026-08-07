"use client";
// "Manage Favorite Recipients" — reuses the same GET /admin/users data and
// the same useFavoriteRecipients mutations as the inline star in every
// SearchableSelect recipient picker; no separate favorites API or logic.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { X, Search, Star, Loader2 } from "lucide-react";
import { PersonBadge } from "./person-badge";
import { useFavoriteRecipients, type FavoritableUser } from "@/hooks/use-favorite-recipients";

export function ManageFavoritesDialog({ onClose }: { onClose: () => void }) {
  const [search, setSearch] = useState("");
  const { data: users = [], isLoading } = useQuery<FavoritableUser[]>({
    queryKey: ["admin-users"],
    queryFn: async () => (await api.get("/admin/users")).data,
  });
  const { toggleFavorite, isToggling } = useFavoriteRecipients();

  const q = search.trim().toLowerCase();
  const filtered = q
    ? users.filter((u) => u.full_name.toLowerCase().includes(q) || u.employee_code?.toLowerCase().includes(q))
    : users;
  const favorites = filtered.filter((u) => u.is_favorite);
  const others = filtered.filter((u) => !u.is_favorite);

  function Row({ u }: { u: FavoritableUser }) {
    return (
      <div className="flex items-center justify-between px-3 py-2.5 hover:bg-gray-50 rounded-xl">
        <PersonBadge person={u} compact />
        <button
          type="button"
          title={u.is_favorite ? "Remove from favorites" : "Add to favorites"}
          onClick={() => toggleFavorite(u.id, !!u.is_favorite)}
          disabled={isToggling}
          className={`p-1.5 rounded-lg shrink-0 disabled:opacity-50 ${u.is_favorite ? "text-amber-400 hover:text-amber-500" : "text-gray-300 hover:text-amber-400"}`}
        >
          <Star size={18} fill={u.is_favorite ? "currentColor" : "none"} />
        </button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-5 border-b border-gray-200 flex items-center justify-between shrink-0">
          <h3 className="text-xl font-bold text-gray-900">Manage Favorite Recipients</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>

        <div className="px-6 py-4 border-b border-gray-100 shrink-0">
          <div className="relative">
            <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search users…"
              className="w-full border border-gray-300 rounded-xl pl-10 pr-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]"
            />
          </div>
        </div>

        <div className="overflow-y-auto px-3 py-3 flex-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-10 gap-2 text-gray-400"><Loader2 size={18} className="animate-spin" /> Loading…</div>
          ) : (
            <>
              {favorites.length > 0 && (
                <>
                  <p className="px-3 pt-1 pb-1.5 text-xs font-bold text-amber-600 uppercase tracking-wide">⭐ Favorite Recipients</p>
                  {favorites.map((u) => <Row key={u.id} u={u} />)}
                  <div className="my-2 border-t border-gray-100" />
                </>
              )}
              <p className="px-3 pt-1 pb-1.5 text-xs font-bold text-gray-400 uppercase tracking-wide">All Recipients</p>
              {others.length === 0 ? (
                <p className="px-3 py-6 text-sm text-gray-400 text-center">No users found.</p>
              ) : (
                others.map((u) => <Row key={u.id} u={u} />)
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
