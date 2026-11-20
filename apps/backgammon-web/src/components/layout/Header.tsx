import Link from "next/link";
import { cn } from "@xion-beginner/ui";

interface HeaderProps {
  title: string;
  subtitle?: string;
  backHref?: string;
  actions?: React.ReactNode;
  className?: string;
}

export function Header({ title, subtitle, backHref, actions, className }: HeaderProps) {
  return (
    <header
      className={cn(
        "flex items-center gap-4 px-6 py-4 border-b border-border-subtle",
        className,
      )}
    >
      {backHref && (
        <Link
          href={backHref}
          aria-label="Back to lobby"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-gold-primary)]"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </Link>
      )}
      <div className="flex-1 min-w-0">
        <h1 className="text-lg font-semibold text-text-primary truncate">{title}</h1>
        {subtitle && (
          <p className="text-sm text-text-muted mt-0.5">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}
