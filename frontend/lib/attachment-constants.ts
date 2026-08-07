// Single source of truth for attachment tag options and allowed file types —
// reused by every attachment upload screen (New File today; Forward and any
// future upload UI should import these rather than redefining their own).

export const ATTACHMENT_TAGS: string[] = [
  ...Array.from({ length: 10 }, (_, k) => `doc-${k + 1}`),
  "Annexure 1", "Annexure 2", "Annexure 3", "Annexure 4", "Annexure 5",
  "Annexure A", "Annexure B", "Annexure C",
  "Supporting Document", "Reference Document",
  "Enclosure 1", "Enclosure 2", "Enclosure 3",
  "Exhibit 1", "Exhibit 2",
  "Proof of Identity", "Proof of Address", "Certificate",
  "Other",
];

export const CUSTOM_TAG_VALUE = "Other";
export const CUSTOM_TAG_MAX_LENGTH = 50;

// Mirrors the backend's settings.ALLOWED_EXTENSIONS (app/core/config.py) —
// keep both lists in sync when changing allowed file types.
export const ALLOWED_ATTACHMENT_EXTENSIONS: string[] = [
  "pdf", "doc", "docx", "xls", "xlsx", "csv", "jpg", "jpeg", "png",
];

export const ALLOWED_ATTACHMENT_ACCEPT = ALLOWED_ATTACHMENT_EXTENSIONS.map((e) => `.${e}`).join(",");

export const ALLOWED_ATTACHMENT_HELP_TEXT = "PDF, DOC, DOCX, XLS, XLSX, CSV, JPG, JPEG, PNG";

export function getFileExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx >= 0 ? filename.slice(idx + 1).toLowerCase() : "";
}

export function isAllowedAttachmentFile(filename: string): boolean {
  return ALLOWED_ATTACHMENT_EXTENSIONS.includes(getFileExtension(filename));
}

/** Trim/empty/whitespace/length validation for a custom "Other" tag.
 * Returns an error message, or null if the value is valid. */
export function validateCustomTag(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Custom tag cannot be empty.";
  if (trimmed.length > CUSTOM_TAG_MAX_LENGTH) return `Custom tag must be ${CUSTOM_TAG_MAX_LENGTH} characters or fewer.`;
  return null;
}
