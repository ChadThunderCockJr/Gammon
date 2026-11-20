"use client";

import { cn } from "@xion-beginner/ui";

interface Pill {
  id: string;
  label: string;
}

interface PillGroupProps {
  pills: Pill[];
  activeId: string;
  onSelect: (id: string) => void;
  className?: string;
  ariaLabel?: string;
}

export function PillGroup({ pills, activeId, onSelect, className, ariaLabel = "Filters" }: PillGroupProps) {
  return (
    <div role="group" aria-label={ariaLabel} className={cn("flex gap-1.5 flex-wrap", className)}>
      {pills.map((pill) => {
        const active = activeId === pill.id;
        return (
          <button
            key={pill.id}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(pill.id)}
            className="rounded-[var(--radius-button)] text-[12px] font-semibold transition-all duration-[120ms] cursor-pointer"
            style={{
              padding: "7px 14px",
              border: `1.5px solid ${active ? "var(--color-gold-primary)" : "var(--color-border-subtle)"}`,
              background: active ? "var(--color-gold-primary)" : "var(--color-bg-surface)",
              color: active ? "var(--color-accent-fg, var(--color-bg-deepest))" : "var(--color-text-secondary)",
            }}
          >
            {pill.label}
          </button>
        );
      })}
    </div>
  );
}
