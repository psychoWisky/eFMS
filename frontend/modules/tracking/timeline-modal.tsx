"use client";
// Centered, vertically-scrollable audit timeline for one file. Reuses the
// existing GET /efms/files/{id}/track (routing + sign events, already
// remark-filtered) and the new GET /efms/files/{id}/track/notesheet (the
// initial notesheet, filtered by the same Tracking History visibility rule)
// — no full-file endpoint here. File-level header info (subject, creator,
// current holder, release) comes from the GET /tracking/history row the
// caller already fetched (passed in as `item`), not from GET
// /efms/files/{id}: that endpoint requires full (current-holder-only)
// access, which a past participant viewing Tracking History may not have —
// see _assert_full_file_access. "Created" and "Released" markers are
// synthesized client-side from data already returned; nothing is fabricated.
//
// Movement/audit view: no attachment details or View/Download controls here
// (that belongs to the normal View File page's attachment panel). Remark/
// notesheet content IS shown here — unlike Track Status inside View File,
// which is forwarding-chain-only by design — but only for entries the
// backend actually sent content for; everything else shows an explicit
// "you don't have access to read this" instead of silently rendering
// nothing, so it's never ambiguous whether something is being withheld.
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/services/api";
import { cn, formatDate, hasRealNotesheetContent } from "@/lib/utils";
import { toSafeNotesheetHtml, NOTESHEET_PROSE_CLASS } from "@/lib/notesheet-html";
import { printTimelinePdf } from "@/lib/timeline-pdf";
import { PersonBadge, type PersonInfo } from "@/components/shared/person-badge";
import { X, FileText, ArrowRight, PenLine, Unlock, Loader2, Lock, Download } from "lucide-react";

interface TrackingItem {
  file_id: string; ref_number: string; subject: string; status: string; priority: string;
  current_holder_info: PersonInfo | null;
  creator_info: PersonInfo | null;
  from_user_info: PersonInfo | null;
  to_user_info: PersonInfo | null;
  forwarded_at: string | null;
  is_released: boolean;
  released_at: string | null;
  released_by_info: PersonInfo | null;
  updated_at: string;
  created_at: string;
}

interface TrackEntry {
  id: string; type?: "route" | "sign"; from_user_id: string | null; to_user_id: string | null;
  from_user_info?: PersonInfo | null; to_user_info?: PersonInfo | null; action: string;
  remarks: string | null; has_remark?: boolean; is_current: boolean; created_at: string;
}

interface InitialNotesheet { content: string | null; has_notesheet: boolean; accessible: boolean; }

interface TimelineEvent {
  key: string;
  type: "created" | "route" | "sign" | "released";
  label: string;
  person?: PersonInfo | null;
  fromPerson?: PersonInfo | null;
  toPerson?: PersonInfo | null;
  // Whether a remark/notesheet exists at all for this event, independent of
  // whether the viewer can see it — lets "no access" be shown only when
  // something is genuinely being withheld, never for an event with nothing
  // to show in the first place.
  hasContent: boolean;
  // The actual safe-to-render HTML, present only when the backend decided
  // this viewer may see it (track_file / track/notesheet already apply the
  // Tracking History visibility rule — nothing is filtered again here).
  content: string | null;
}

function buildTimeline(item: TrackingItem, trackEntries: TrackEntry[], initialNotesheet?: InitialNotesheet): (TimelineEvent & { created_at: string })[] {
  // Merge "Created" with the FIRST forward, but only when that first
  // tracking entry actually is a forward authored by the creator — a
  // dispatch, a sign event, or no entries at all (never-forwarded Draft)
  // all leave "Created" standing alone, exactly as before.
  const firstEntry = trackEntries[0];
  const firstIsCreatorForward =
    !!firstEntry && firstEntry.type !== "sign" && firstEntry.action === "forward" &&
    !!item.creator_info?.id && firstEntry.from_user_id === item.creator_info.id;

  // Content that isn't actually written by anyone (blank / untouched
  // placeholder) is dropped to null so it renders as nothing — never a
  // blank box and never a misleading "no access" line. `hasContent` now
  // means strictly "a note exists but is withheld from this viewer".
  const initialContent =
    initialNotesheet?.accessible && hasRealNotesheetContent(initialNotesheet.content)
      ? initialNotesheet.content
      : null;
  const initialWithheld = !!initialNotesheet?.has_notesheet && !initialNotesheet?.accessible;

  const events: (TimelineEvent & { created_at: string })[] = [
    firstIsCreatorForward
      ? {
          key: "created", type: "created", label: "Created and forwarded",
          fromPerson: item.creator_info, toPerson: firstEntry.to_user_info,
          hasContent: initialWithheld,
          content: initialContent,
          // The combined entry is dated by when the forward actually
          // happened (when the file left the creator), not by the file's
          // own created_at, which may predate it by any amount of time.
          created_at: firstEntry.created_at,
        }
      : {
          key: "created", type: "created", label: "Created", person: item.creator_info,
          hasContent: initialWithheld,
          content: initialContent,
          created_at: item.created_at,
        },
  ];

  for (const e of trackEntries) {
    if (firstIsCreatorForward && e === firstEntry) continue; // already folded into the "created" event above
    const realRemark = hasRealNotesheetContent(e.remarks) ? e.remarks : null;
    // Withheld = the backend knows a remark exists but redacted it (sent
    // null). A remark that came through blank/placeholder is not withheld,
    // it's just nothing to show.
    const withheld = !!e.has_remark && e.remarks == null;
    if (e.type === "sign") {
      events.push({ key: e.id, type: "sign", label: "Signed", person: e.from_user_info, hasContent: withheld, content: realRemark, created_at: e.created_at });
    } else {
      events.push({
        key: e.id, type: "route", label: e.action === "dispatch" ? "Dispatched" : "Forwarded",
        fromPerson: e.from_user_info, toPerson: e.to_user_info, hasContent: withheld, content: realRemark, created_at: e.created_at,
      });
    }
  }

  // "Currently Released" reflects only the latest release (no history of
  // prior release/reopen cycles is stored anywhere).
  if (item.is_released && item.released_at) {
    events.push({ key: "released", type: "released", label: "Released", person: item.released_by_info, hasContent: false, content: null, created_at: item.released_at });
  }

  events.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  return events;
}

const EVENT_STYLE: Record<TimelineEvent["type"], { bg: string; icon: React.ElementType }> = {
  created:  { bg: "bg-gray-500 border-gray-500",     icon: FileText },
  route:    { bg: "bg-[#0D6E6E] border-[#0D6E6E]",   icon: ArrowRight },
  sign:     { bg: "bg-emerald-600 border-emerald-600", icon: PenLine },
  released: { bg: "bg-green-600 border-green-600",   icon: Unlock },
};

export function TimelineModal({ item, onClose }: { item: TrackingItem; onClose: () => void }) {
  const { data: trackEntries = [], isLoading: loadingTrack } = useQuery<TrackEntry[]>({
    queryKey: ["tracking-file-track", item.file_id],
    queryFn: async () => (await api.get(`/efms/files/${item.file_id}/track`)).data,
  });
  const { data: initialNotesheet, isLoading: loadingNotesheet } = useQuery<InitialNotesheet>({
    queryKey: ["tracking-file-notesheet", item.file_id],
    queryFn: async () => (await api.get(`/efms/files/${item.file_id}/track/notesheet`)).data,
  });

  const isLoading = loadingTrack || loadingNotesheet;
  const events = buildTimeline(item, trackEntries, initialNotesheet);

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-gray-200 shrink-0">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xl font-bold text-gray-900">File Timeline</h3>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const ok = printTimelinePdf(item, events);
                  if (!ok) toast.error("Please allow pop-ups for this site to download the timeline.");
                }}
                disabled={isLoading || events.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold text-[#0D6E6E] border border-[#0D6E6E]/30 rounded-lg hover:bg-[#F0F7F7] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Download size={15} /> Download PDF
              </button>
              <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div><span className="text-gray-400 uppercase text-xs font-semibold">File Number</span><p className="font-mono font-bold text-[#0D6E6E]">{item.ref_number}</p></div>
            <div><span className="text-gray-400 uppercase text-xs font-semibold">Subject</span><p className="font-semibold text-gray-900 truncate">{item.subject}</p></div>
            <div><span className="text-gray-400 uppercase text-xs font-semibold">Current Status</span><p className="capitalize">{item.is_released ? "Released" : item.status}</p></div>
            <div><span className="text-gray-400 uppercase text-xs font-semibold">Current Holder</span><PersonBadge person={item.current_holder_info} compact /></div>
          </div>
        </div>

        <div className="overflow-y-auto px-6 py-5 flex-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-16 gap-3 text-gray-400"><Loader2 className="animate-spin" size={22} /> Loading…</div>
          ) : events.length === 0 ? (
            <p className="text-center text-gray-400 py-16">No timeline events found.</p>
          ) : (
            <div>
              {events.map((ev, i) => {
                const style = EVENT_STYLE[ev.type];
                const Icon = style.icon;
                // `hasContent` now means strictly "a note exists for this
                // event but the backend withheld it". A blank / never-
                // written note is neither shown nor flagged.
                const showNoAccess = ev.hasContent;
                return (
                  <div key={ev.key} className="flex items-start gap-4">
                    <div className="flex flex-col items-center">
                      <div className={cn("w-9 h-9 rounded-full flex items-center justify-center shrink-0 border-2 text-white", style.bg)}>
                        <Icon size={15} />
                      </div>
                      {i < events.length - 1 && <div className="w-0.5 flex-1 min-h-[28px] bg-gray-200 mt-1" />}
                    </div>
                    <div className="flex-1 pb-6">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-base font-bold text-gray-900">{ev.label}</p>
                        <span className="text-xs text-gray-400 shrink-0">{formatDate(ev.created_at, "datetime")}</span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
                        {ev.type === "route" || (ev.type === "created" && ev.toPerson) ? (
                          <>
                            <PersonBadge person={ev.fromPerson} fallback="System" compact />
                            {ev.toPerson && (
                              <>
                                <ArrowRight size={12} className="text-gray-400 shrink-0" />
                                <PersonBadge person={ev.toPerson} compact />
                              </>
                            )}
                          </>
                        ) : (
                          <PersonBadge person={ev.person} fallback="System" compact />
                        )}
                      </div>
                      {ev.content && (
                        <div className={cn("bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 mt-2", NOTESHEET_PROSE_CLASS)}
                          dangerouslySetInnerHTML={{ __html: toSafeNotesheetHtml(ev.content) }} />
                      )}
                      {showNoAccess && (
                        <p className="text-sm text-gray-400 mt-1.5 flex items-center gap-1.5">
                          <Lock size={12} /> You don&apos;t have access to read this
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
