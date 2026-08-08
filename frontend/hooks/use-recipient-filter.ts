"use client";
// Office -> Section -> Recipient cascading filter, shared by every recipient
// picker (New File creation, Edit Draft, and Forward on an existing/received
// file) so they all filter identically instead of the received-file pickers
// only ever seeing the unfiltered /admin/users list. Reuses the exact same
// /admin/establishments -> /admin/departments?establishment_id= ->
// /admin/users?establishment_id=&department_id= cascade New File creation
// already used — no second filtering implementation.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { FavoritableUser } from "@/hooks/use-favorite-recipients";

export interface Establishment { id: string; name: string; }
export interface DeptItem { id: string; name: string; establishment_id: string | null; }
export interface RecipientCandidate extends FavoritableUser {
  active_role?: string | null;
}

export function useRecipientFilter() {
  const [officeId, setOfficeIdRaw] = useState("");
  const [sectionId, setSectionId] = useState("");

  const { data: offices = [] } = useQuery<Establishment[]>({
    queryKey: ["establishments"],
    queryFn: async () => (await api.get("/admin/establishments")).data,
  });
  const { data: sections = [] } = useQuery<DeptItem[]>({
    queryKey: ["departments", officeId],
    queryFn: async () => (await api.get(`/admin/departments?establishment_id=${officeId}`)).data,
    enabled: !!officeId,
  });
  const { data: users = [], isFetching: loadingUsers } = useQuery<RecipientCandidate[]>({
    queryKey: ["admin-users", officeId, sectionId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (officeId) params.set("establishment_id", officeId);
      if (sectionId) params.set("department_id", sectionId);
      return (await api.get(`/admin/users?${params.toString()}`)).data;
    },
  });

  // Changing Office clears Section — same as New File creation, since a
  // Section only makes sense within the currently selected Office.
  function setOfficeId(v: string) {
    setOfficeIdRaw(v);
    setSectionId("");
  }

  return { officeId, setOfficeId, sectionId, setSectionId, offices, sections, users, loadingUsers };
}
