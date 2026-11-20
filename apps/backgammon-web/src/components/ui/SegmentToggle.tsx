"use client";

import { cn } from "@xion-beginner/ui";

interface Segment {
  id: string;
  label: string;
}

interface SegmentToggleProps {
  segments: Segment[];
  activeId: string;
  onSelect: (id: string) => void;
  className?: string;
  ariaLabel?: string;
}

export function SegmentToggle({ segments, activeId, onSelect, className, ariaLabel = "Options" }: SegmentToggleProps) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("flex overflow-hidden", className)}
      style={{
        borderRadius: "var(--radius-card)",
        border: "1px solid var(--color-border-subtle)",
      }}
    >
      {segments.map((segment, i) => {
        const active = activeId === segment.id;
        return (
          <button
            key={segment.id}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(segment.id)}
            onKeyDown={(event) => {
              const offset = event.key === "ArrowRight" || event.key === "ArrowDown"
                ? 1
                : event.key === "ArrowLeft" || event.key === "ArrowUp"
                  ? -1
                  : 0;
              if (offset === 0) return;
              event.preventDefault();
              const nextIndex = (i + offset + segments.length) % segments.length;
              onSelect(segments[nextIndex].id);
              const controls = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
              controls?.[nextIndex]?.focus();
            }}
            style={{
              flex: 1,
              padding: "10px 0",
              background: active ? "var(--color-gold-primary)" : "var(--color-bg-surface)",
              color: active ? "var(--color-accent-fg, var(--color-bg-deepest))" : "var(--color-text-muted)",
              border: "none",
              borderLeft: i > 0 ? "1px solid var(--color-border-subtle)" : "none",
              fontSize: "0.8125rem",
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "var(--font-body)",
            }}
          >
            {segment.label}
          </button>
        );
      })}
    </div>
  );
}
