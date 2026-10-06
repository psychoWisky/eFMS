// The same department (e.g. "Accounts") can exist in several establishments,
// so a list of departments can contain identical names. This returns a label
// function that adds " — <Establishment>" ONLY where a name would otherwise
// be ambiguous within the given list; unique names stay plain.
export function makeDepartmentLabel(
  departments: { id: string; name: string; establishment_id?: string | null }[],
  establishments: { id: string; name: string }[],
): (d: { id: string; name: string; establishment_id?: string | null }) => string {
  const count = new Map<string, number>();
  for (const d of departments) {
    const key = d.name.trim().toLowerCase();
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  const estbName = new Map(establishments.map((e) => [e.id, e.name]));
  return (d) => {
    const dup = (count.get(d.name.trim().toLowerCase()) ?? 0) > 1;
    const estb = d.establishment_id ? estbName.get(d.establishment_id) : undefined;
    return dup && estb ? `${d.name} — ${estb}` : d.name;
  };
}
