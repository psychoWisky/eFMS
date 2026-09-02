import { cn } from "@/lib/utils";

// Single header treatment for every top-level page (Dashboard, Search,
// Tracking, Admin). Keeps the title size, meta line, padding and optional
// right-aligned actions identical everywhere instead of each page hand-
// rolling its own `bg-white border-b px-8 py-5` block.
export function PageHeader({
  title,
  subtitle,
  icon: Icon,
  actions,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ElementType;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("bg-white border-b border-gray-200 px-6 py-4", className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-[#1A1A2E] flex items-center gap-2">
            {Icon && <Icon size={20} className="text-[#0D6E6E] shrink-0" />}
            {title}
          </h1>
          {subtitle && <p className="text-sm text-[#4A5568] mt-0.5">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </div>
  );
}
