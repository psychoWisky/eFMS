"use client";
import { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  variant?: "default" | "success";
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, variant = "default", className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center text-center py-10 px-4", className)}>
      {Icon && (
        <div className={cn(
          "w-14 h-14 rounded-full flex items-center justify-center mb-4",
          variant === "success" ? "bg-green-50" : "bg-[#F0F7F7]"
        )}>
          <Icon size={24} className={variant === "success" ? "text-green-500" : "text-[#0D6E6E]"} />
        </div>
      )}
      <p className="text-[16px] font-semibold text-[#1A1A2E]">{title}</p>
      {description && <p className="text-[14px] text-[#4A5568] mt-1 max-w-xs">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
