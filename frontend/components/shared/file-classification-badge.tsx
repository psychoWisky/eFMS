"use client";
// Single source of truth for how a file's classification (derived from its
// FilePriority: normal | urgent | secret) is labeled and colored across the
// app — badge for lists/headers, banner for the file viewer.
import { AlertCircle, Lock } from "lucide-react";
import { cn } from "@/lib/utils";

interface ClassificationMeta {
  label: string;
  icon: typeof AlertCircle | null;
  badgeClass: string;
}

const CLASSIFICATION_META: Record<string, ClassificationMeta> = {
  urgent: { label: "Urgent", icon: AlertCircle, badgeClass: "bg-red-100 text-red-700" },
  secret: { label: "Confidential", icon: Lock, badgeClass: "bg-purple-100 text-purple-700" },
};
const DEFAULT_META: ClassificationMeta = { label: "Normal", icon: null, badgeClass: "bg-gray-100 text-gray-600" };

function metaFor(priority: string): ClassificationMeta {
  return CLASSIFICATION_META[priority] ?? DEFAULT_META;
}

export function FileClassificationBadge({
  priority, compact = false, className,
}: { priority: string; compact?: boolean; className?: string }) {
  const m = metaFor(priority);
  const Icon = m.icon;
  return (
    <span className={cn(
      "inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-semibold whitespace-nowrap capitalize",
      compact ? "text-xs" : "text-sm",
      m.badgeClass, className,
    )}>
      {Icon && <Icon size={compact ? 11 : 13} />}
      {m.label}
    </span>
  );
}

export function FileClassificationBanner({ priority }: { priority: string }) {
  if (priority === "secret") {
    return (
      <div className="rounded-xl border border-purple-200 bg-purple-50 px-4 py-3">
        <p className="text-sm font-bold text-purple-800">🔒 Confidential File</p>
        <p className="text-sm text-purple-700 mt-0.5">This file contains confidential information. Please handle it appropriately.</p>
      </div>
    );
  }
  if (priority === "urgent") {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
        <p className="text-sm font-bold text-red-800">🚨 Urgent File</p>
        <p className="text-sm text-red-700 mt-0.5">This file requires immediate attention.</p>
      </div>
    );
  }
  return null;
}
