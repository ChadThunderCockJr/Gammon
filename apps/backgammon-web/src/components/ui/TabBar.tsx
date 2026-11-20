"use client";

import { cn } from "@xion-beginner/ui";

interface Tab {
  id: string;
  label: string;
}

interface TabBarProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (id: string) => void;
  className?: string;
  ariaLabel?: string;
}

export function TabBar({ tabs, activeTab, onTabChange, className, ariaLabel = "Sections" }: TabBarProps) {
  return (
    <div role="tablist" aria-label={ariaLabel} className={cn("flex", className)}>
      {tabs.map((tab) => {
        const active = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onTabChange(tab.id)}
            onKeyDown={(event) => {
              const index = tabs.findIndex((candidate) => candidate.id === tab.id);
              const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (offset === 0) return;
              event.preventDefault();
              const nextIndex = (index + offset + tabs.length) % tabs.length;
              onTabChange(tabs[nextIndex].id);
              const controls = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
              controls?.[nextIndex]?.focus();
            }}
            className={cn(
              "flex-1 py-3.5 text-[13px] transition-colors relative cursor-pointer bg-transparent border-none",
              active
                ? "text-text-primary font-bold"
                : "text-text-muted font-medium hover:text-text-secondary",
            )}
            style={{
              borderBottom: `2.5px solid ${active ? "var(--color-gold-primary)" : "transparent"}`,
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
