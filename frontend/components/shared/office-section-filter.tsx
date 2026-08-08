"use client";
// The Office/Section pair of the recipient filter — paired with
// useRecipientFilter (data) so every recipient picker renders the same two
// fields the same way instead of each screen re-building this UI.
import { SearchableSelect } from "@/components/shared/searchable-select";
import type { Establishment, DeptItem } from "@/hooks/use-recipient-filter";

export function OfficeSectionFilter({
  officeId, sectionId, offices, sections, onOfficeChange, onSectionChange,
}: {
  officeId: string;
  sectionId: string;
  offices: Establishment[];
  sections: DeptItem[];
  onOfficeChange: (v: string) => void;
  onSectionChange: (v: string) => void;
}) {
  return (
    <>
      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-1.5">Office</label>
        <SearchableSelect
          options={offices.map((o) => ({ value: o.id, label: o.name }))}
          value={officeId}
          onChange={onOfficeChange}
          placeholder="All offices…"
          searchPlaceholder="Search offices…"
        />
      </div>
      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-1.5">Section</label>
        <SearchableSelect
          options={sections.map((s) => ({ value: s.id, label: s.name }))}
          value={sectionId}
          onChange={onSectionChange}
          placeholder={officeId ? "All sections…" : "Select an Office first"}
          searchPlaceholder="Search sections…"
          disabled={!officeId}
        />
      </div>
    </>
  );
}
