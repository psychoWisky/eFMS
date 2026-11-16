"use client";
// Admin → Multiple designations.
//
// Normally a person holds a role once per establishment / department. Some
// people (e.g. an In-charge of several things in ONE establishment, often with
// no department) need the SAME role in the SAME place more than once. Here the
// Super Admin chooses WHO is allowed (several at once). The posts themselves
// are then given in User Management → Edit User → Additional roles, where a
// pop-up asks to confirm when the person already holds that role there.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, Loader2, Search, UserCheck, UserPlus, X } from "lucide-react";
import { api } from "@/services/api";
import { cn } from "@/lib/utils";
import { apiErrorDetail, confirmAction, showBlocked, showSuccess } from "@/lib/alert";

interface Post {
  id: string; role: string; role_label: string;
  establishment_name: string | null; department_name: string | null;
  designation: string | null; effective_designation: string | null;
  shared_place: boolean; is_active_post: boolean;
}
interface Allowed {
  user: { id: string; full_name: string; email: string; designation: string | null; is_active: boolean };
  posts: Post[]; duplicate_places: number;
}
interface Person { id: string; full_name: string; email: string; designation: string | null; is_active: boolean; is_retired?: boolean }

const STEP = "w-7 h-7 rounded-full bg-[#0D6E6E] text-white text-sm font-bold flex items-center justify-center shrink-0";

export function MultiDesignationSection() {
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["multi-designation"] });
    qc.invalidateQueries({ queryKey: ["user-management-users"] });
  };

  const { data: allowed = [], isLoading } = useQuery<Allowed[]>({
    queryKey: ["multi-designation"], queryFn: async () => (await api.get("/admin/multi-designation")).data,
  });
  const { data: people = [] } = useQuery<Person[]>({
    queryKey: ["user-management-users", "multi-designation-people"],
    queryFn: async () => (await api.get("/auth/admin/users", { params: { status: "active" } })).data,
    select: (rows) => rows.filter((u) => u.is_active && !u.is_retired),
  });

  const allowedIds = useMemo(() => new Set(allowed.map((a) => a.user.id)), [allowed]);
  const [search, setSearch] = useState("");
  const [ticked, setTicked] = useState<string[]>([]);
  const candidates = people.filter((p) => !allowedIds.has(p.id));
  const q = search.trim().toLowerCase();
  const shown = candidates.filter((p) => !q || [p.full_name, p.designation, p.email].some((v) => (v ?? "").toLowerCase().includes(q)));
  const allShownTicked = shown.length > 0 && shown.every((p) => ticked.includes(p.id));
  const toggle = (id: string) => setTicked((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  const toggleAllShown = () => setTicked((t) => (allShownTicked ? t.filter((id) => !shown.some((p) => p.id === id)) : Array.from(new Set([...t, ...shown.map((p) => p.id)]))));

  const allow = useMutation({
    mutationFn: async () => (await api.post("/admin/multi-designation/users", { user_ids: ticked })).data as { added: string[]; skipped: string[] },
    onSuccess: (d) => {
      setTicked([]);
      refresh();
      showSuccess(`${d.added.length} ${d.added.length === 1 ? "person" : "people"} added to the list.`);
      if (d.skipped.length) toast.info(`Skipped: ${d.skipped.join(", ")}`);
    },
    onError: (err) => toast.error(apiErrorDetail(err) ?? "Could not add the people."),
  });

  async function disallow(a: Allowed) {
    if (!(await confirmAction({
      title: `Take ${a.user.full_name} off the list?`,
      text: "They will no longer be able to hold the same role twice in one place.", confirmText: "Take off", danger: true,
    }))) return;
    try { await api.delete(`/admin/multi-designation/users/${a.user.id}`); refresh(); showSuccess("Taken off the list."); }
    catch (err) {
      const msg = apiErrorDetail(err) ?? "Could not take them off the list.";
      if (msg.includes("\n")) await showBlocked(msg); else toast.error(msg);
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-900">
        <p className="font-semibold">What is this?</p>
        <p className="mt-1">
          Normally a person can hold a role <b>once</b> in an establishment / department. Some people — for example an <b>In-charge</b> of
          several things in one establishment — need the <b>same role in the same place more than once</b>. Choose <b>who is allowed</b> below.
          Then give them the extra roles in <b>User Management → Edit User → Additional roles</b>: type a different <b>designation</b> for each,
          and a pop-up asks you to confirm when they already hold that role there. Each one is its own post with its own Docket and My Files,
          and the designation shows in the Docket and the recipient list. Everyone not on this list keeps the normal one-role-per-place rule.
        </p>
      </div>

      {/* Choose who is allowed */}
      <div className="bg-gray-50 rounded-xl border border-gray-200 p-4">
        <div className="flex items-start gap-3 mb-3">
          <span className={STEP}><UserPlus size={15} /></span>
          <div>
            <p className="text-sm font-semibold text-gray-800">Choose who is allowed</p>
            <p className="text-xs text-gray-500">Tick one or many people, then click Allow.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <div className="relative flex-1 min-w-[220px]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, designation or e-mail…"
              className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0D6E6E]" />
          </div>
          <button type="button" onClick={toggleAllShown} disabled={shown.length === 0}
            className="px-3 py-2.5 border border-gray-300 bg-white rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-100 disabled:opacity-50 whitespace-nowrap">
            {allShownTicked ? "Untick all shown" : `Tick all shown (${shown.length})`}
          </button>
        </div>
        <div className="max-h-72 overflow-y-auto bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          {shown.length === 0 && (
            <p className="text-sm text-gray-400 px-3 py-6 text-center">
              {candidates.length === 0 ? "Everyone is already on the list." : "No person matches your search."}
            </p>
          )}
          {shown.map((p) => (
            <label key={p.id} className={cn("flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-gray-50", ticked.includes(p.id) && "bg-[#F4FAF9]")}>
              <input type="checkbox" checked={ticked.includes(p.id)} onChange={() => toggle(p.id)} className="accent-[#0D6E6E] w-4 h-4 shrink-0" />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-gray-900 truncate">{p.full_name}</span>
                <span className="block text-xs text-gray-500 truncate">{[p.designation, p.email].filter(Boolean).join(" · ")}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => allow.mutate()} disabled={ticked.length === 0 || allow.isPending}
            className="flex items-center gap-1.5 px-4 py-2.5 bg-[#0D6E6E] text-white rounded-lg text-sm font-semibold hover:bg-[#178F8F] disabled:opacity-50">
            {allow.isPending ? <Loader2 size={15} className="animate-spin" /> : <UserPlus size={15} />}
            {ticked.length ? `Allow ${ticked.length} selected` : "Tick people to allow"}
          </button>
          {ticked.length > 0 && <button type="button" onClick={() => setTicked([])} className="text-xs font-semibold text-gray-500 hover:underline">Clear selection</button>}
        </div>
      </div>

      {/* Allowed people */}
      <div>
        <p className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2"><UserCheck size={16} className="text-[#0D6E6E]" /> Allowed people ({allowed.length})</p>
        {isLoading && <p className="text-center text-gray-400 py-6"><Loader2 className="inline animate-spin" /></p>}
        {!isLoading && allowed.length === 0 && <p className="text-sm text-gray-400 py-6 text-center">Nobody is on the list yet.</p>}
        <div className="space-y-3">
          {allowed.map((a) => (
            <div key={a.user.id} className="bg-white rounded-xl border border-gray-200">
              <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-100">
                <div className="min-w-0">
                  <p className="text-base font-semibold text-gray-900 truncate">{a.user.full_name}</p>
                  <p className="text-xs text-gray-500 truncate">{[a.user.designation, a.user.email].filter(Boolean).join(" · ")}</p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {a.duplicate_places > 0 && (
                    <span className="text-xs font-semibold text-[#0A5757] bg-[#E6F4F4] border border-[#BFDEDB] rounded-full px-2.5 py-0.5 flex items-center gap-1">
                      <Copy size={11} /> {a.duplicate_places} place{a.duplicate_places === 1 ? "" : "s"} with several posts
                    </span>
                  )}
                  <button onClick={() => disallow(a)} className="text-xs font-semibold text-red-600 hover:underline flex items-center gap-1"><X size={13} /> Take off list</button>
                </div>
              </div>
              <div className="divide-y divide-gray-100">
                {a.posts.length === 0 && <p className="px-4 py-3 text-sm text-gray-400">No roles yet.</p>}
                {a.posts.map((p) => (
                  <div key={p.id} className={cn("px-4 py-2.5", p.shared_place && "bg-[#F4FAF9]")}>
                    <p className="text-sm font-semibold text-gray-900">
                      {p.role_label}
                      <span className="font-normal text-gray-500"> — {[p.establishment_name, p.department_name].filter(Boolean).join(" / ") || "no place"}</span>
                    </p>
                    <p className="text-xs text-gray-600">
                      Designation: <b>{p.effective_designation ?? "—"}</b>{!p.designation && p.effective_designation ? " (their own)" : ""}
                      {p.shared_place && <span className="ml-2 text-[#0A5757] font-semibold">· same role also held here under another designation</span>}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
