// Display name for a role, with its earlier name(s) when it has been renamed:
// "New Name (formerly Old Name)". The backend stores raw role names
// ("records_officer") — this turns them into what people read.

export function roleDisplayName(name: string): string {
  return name.split("_").map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" ");
}

/** "New Name (formerly Old Name)"; just "New Name" when never renamed, and
 * null when there is no role. `formerly` may be one earlier name or the
 * whole chain, oldest first ("A → B"). */
export function roleWithFormerly(
  role: string | null | undefined,
  formerly?: string | string[] | null,
): string | null {
  if (!role) return null;
  const earlier = (Array.isArray(formerly) ? formerly : formerly ? [formerly] : [])
    .filter(Boolean)
    .map(roleDisplayName);
  return earlier.length > 0
    ? `${roleDisplayName(role)} (formerly ${earlier.join(" → ")})`
    : roleDisplayName(role);
}
