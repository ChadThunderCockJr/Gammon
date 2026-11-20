import Link from "next/link";

export default function TournamentsPage() {
  return <main className="mx-auto max-w-2xl space-y-5 p-6"><h1 className="font-display text-3xl">Tournaments</h1><section className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-6"><h2 className="text-xl font-semibold">Not accepting registrations</h2><p className="mt-3 text-sm text-[var(--color-text-secondary)]">Tournament registration and prize pools are not available in this release. We do not collect entry fees or represent a prize before the bracket, custody, eligibility, rules, and settlement controls exist.</p><Link href="/create-match" className="mt-4 inline-flex min-h-11 items-center rounded bg-[var(--color-gold-primary)] px-4 py-2 font-semibold">Create a free match</Link></section></main>;
}
