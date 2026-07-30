"use client";
// Centered, vertically-scrollable audit timeline for one file. Reuses the
// existing GET /efms/files/{id}/track (routing + sign events, already
// remark-filtered) and GET /efms/files/{id} (already attachment-filtered) —
// no new backend endpoint, no new history model. "Created" and "Released"
// markers are synthesized client-side from data those endpoints already
// return; nothing is fabricated (see report: no "Reopened" event exists in
// the underlying data, so none is shown here).
import { useQuery } from "@tanstack/react-query";
import { api, API_URL } from "@/services/api";
import { cn, formatDate, isPreviewable } from "@/lib/utils";
import { PersonBadge, type PersonInfo } from "@/components/shared/person-badge";
import { X, FileText, ArrowRight, PenLine, Unlock, Loader2 } from "lucide-react";

interface Attachment { id: string; original_name: string; file_size: number | null; mime_type: string | null; uploaded_by: string; created_at: string; }
interface TrackEntry { id: string; type?: "route" | "sign"; from_user_id: string | null; to_user_id: string | null; from_user_info?: PersonInfo | null; to_user_info?: PersonInfo | null; action: string; remarks: string | null; is_current: boolean; created_at: string; }
interface FileDetail {
  id: string; ref_number: string; subject: string; status: string; is_released: boolean;
  released_at: string | null; released_by_info?: PersonInfo | null;
  creator_info?: PersonInfo | null; current_holder_info?: PersonInfo | null;
  created_at: string; attachments: Attachment[];
}

interface TimelineEvent {
  key: string;
  type: "created" | "route" | "sign" | "released";
  label: string;
  person?: PersonInfo | null;
  fromPerson?: PersonInfo | null;
  toPerson?: PersonInfo | null;
  remarks?: string | null;
  created_at: string;
  attachments: Attachment[];
}

function buildTimeline(file: FileDetail, trackEntries: TrackEntry[]): TimelineEvent[] {
  const events: TimelineEvent[] = [
    { key: "created", type: "created", label: "Created", person: file.creator_info, created_at: file.created_at, attachments: [] },
  ];

  for (const e of trackEntries) {
    if (e.type === "sign") {
      events.push({ key: e.id, type: "sign", label: "Signed", person: e.from_user_info, remarks: e.remarks, created_at: e.created_at, attachments: [] });
    } else {
      events.push({
        key: e.id, type: "route", label: e.action === "dispatch" ? "Dispatched" : "Forwarded",
        fromPerson: e.from_user_info, toPerson: e.to_user_info, remarks: e.remarks, created_at: e.created_at, attachments: [],
      });
    }
  }

  // "Currently Released" reflects only the latest release (see report: no
  // history of prior release/reopen cycles is stored anywhere).
  if (file.is_released && file.released_at) {
    events.push({ key: "released", type: "released", label: "Released", person: file.released_by_info, created_at: file.released_at, attachments: [] });
  }

  events.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  // Bucket each (already viewer-filtered) attachment under the last event
  // that happened at or before it — original attachments naturally land on
  // "Created"; later uploads land on whichever forward preceded them.
  const atts = [...file.attachments].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  for (const att of atts) {
    const attTime = new Date(att.created_at).getTime();
    let target: TimelineEvent | null = null;
    for (const ev of events) {
      if (new Date(ev.created_at).getTime() > attTime) break;
      target = ev;
    }
    if (target) target.attachments.push(att);
  }

  return events;
}

const EVENT_STYLE: Record<TimelineEvent["type"], { bg: string; icon: React.ElementType }> = {
  created:  { bg: "bg-gray-500 border-gray-500",     icon: FileText },
  route:    { bg: "bg-[#0D6E6E] border-[#0D6E6E]",   icon: ArrowRight },
  sign:     { bg: "bg-emerald-600 border-emerald-600", icon: PenLine },
  released: { bg: "bg-green-600 border-green-600",   icon: Unlock },
};

export function TimelineModal({ fileId, onClose }: { fileId: string; onClose: () => void }) {
  const { data: file, isLoading: loadingFile } = useQuery<FileDetail>({
    queryKey: ["tracking-file-detail", fileId],
    queryFn: async () => (await api.get(`/efms/files/${fileId}`)).data,
  });
  const { data: trackEntries = [], isLoading: loadingTrack } = useQuery<TrackEntry[]>({
    queryKey: ["tracking-file-track", fileId],
    queryFn: async () => (await api.get(`/efms/files/${fileId}/track`)).data,
  });

  const loading = loadingFile || loadingTrack;
  const events = file ? buildTimeline(file, trackEntries) : [];

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-gray-200 shrink-0">
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-bold text-gray-900">File Timeline</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
          </div>
          {file && (
            <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <div><span className="text-gray-400 uppercase text-xs font-semibold">File Number</span><p className="font-mono font-bold text-[#0D6E6E]">{file.ref_number}</p></div>
              <div><span className="text-gray-400 uppercase text-xs font-semibold">Subject</span><p className="font-semibold text-gray-900 truncate">{file.subject}</p></div>
              <div><span className="text-gray-400 uppercase text-xs font-semibold">Current Status</span><p className="capitalize">{file.is_released ? "Released" : file.status}</p></div>
              <div><span className="text-gray-400 uppercase text-xs font-semibold">Current Holder</span><PersonBadge person={file.current_holder_info} compact /></div>
            </div>
          )}
        </div>

        <div className="overflow-y-auto px-6 py-5 flex-1">
          {loading ? (
            <div className="flex items-center justify-center py-16 gap-3 text-gray-400"><Loader2 className="animate-spin" size={22} /> Loading…</div>
          ) : events.length === 0 ? (
            <p className="text-center text-gray-400 py-16">No timeline events found.</p>
          ) : (
            <div>
              {events.map((ev, i) => {
                const style = EVENT_STYLE[ev.type];
                const Icon = style.icon;
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
                        {ev.type === "route" ? (
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
                      {ev.remarks && <p className="text-sm text-gray-500 mt-1.5 italic">&ldquo;{ev.remarks}&rdquo;</p>}
                      {ev.attachments.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {ev.attachments.map((a) => (
                            <div key={a.id} className="flex items-center gap-1.5 text-xs bg-gray-50 border border-gray-200 rounded-lg px-2 py-1">
                              <FileText size={12} className="text-gray-400 shrink-0" />
                              <span className="truncate max-w-[140px]">{a.original_name}</span>
                              {isPreviewable(a) ? (
                                <a href={`/api/attachments/${fileId}/${a.id}/view`} target="_blank" rel="noreferrer" className="text-[#0D6E6E] font-semibold hover:underline">View</a>
                              ) : (
                                <span className="text-gray-400">No preview</span>
                              )}
                              <a href={`${API_URL}/efms/files/${fileId}/attachments/${a.id}/download`} className="text-gray-500 hover:underline">Download</a>
                            </div>
                          ))}
                        </div>
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
