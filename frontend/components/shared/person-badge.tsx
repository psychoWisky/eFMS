// Single source of truth for displaying "who did this" everywhere in eFMS:
// name + designation + department. Every screen (Track Status, Forwarding
// Remarks, Docket, File Details, ...) reuses this component instead of
// rendering a bare name.
import { cn } from "@/lib/utils";

export interface PersonInfo {
  id?: string;
  full_name: string;
  designation?: string | null;
  department_name?: string | null;
  is_active?: boolean;
}

export function PersonBadge({
  person,
  compact = false,
  fallback = "—",
  className,
}: {
  person: PersonInfo | null | undefined;
  /** Use in space-constrained contexts (compact tables): "Name (Designation • Department)" on two lines instead of three. */
  compact?: boolean;
  fallback?: string;
  className?: string;
}) {
  if (!person) return <span className={cn("text-gray-400", className)}>{fallback}</span>;

  const meta = [person.designation, person.department_name].filter(Boolean).join(" • ");
  const displayName = person.is_active === false ? `${person.full_name} (Inactive)` : person.full_name;

  if (compact) {
    return (
      <span className={cn("inline-block leading-snug", className)}>
        <span className="font-semibold text-gray-900">{displayName}</span>
        {meta && <span className="block text-xs text-gray-500">({meta})</span>}
      </span>
    );
  }

  return (
    <span className={cn("inline-block leading-snug", className)}>
      <span className="block font-semibold text-gray-900">{displayName}</span>
      {person.designation && <span className="block text-sm text-gray-600">{person.designation}</span>}
      {person.department_name && <span className="block text-sm text-gray-500">{person.department_name}</span>}
    </span>
  );
}
