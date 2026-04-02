# Design System — Gammon.nyc

## Product Context
- **What this is:** Competitive online backgammon with provably fair dice, AI analysis, and USDC wagering
- **Who it's for:** Competitive backgammon players who care about dice fairness and skill improvement
- **Space/industry:** Online board gaming, skill-based wagering
- **Project type:** Web app (game client) + real-time server

## Aesthetic Direction
- **Direction:** Luxury/Refined — Premium club, not crypto casino
- **Decoration level:** Intentional — Subtle felt texture on backgrounds, gold glow on verification badges. No decorative blobs, gradients, or floating shapes.
- **Mood:** Walking into a serious backgammon club with leather chairs and felt tables. The kind of place where people play for real money and respect the game. Not flashy, not tech-startup, not casino. Quiet confidence.
- **Reference sites:** Lichess.org (information density, no marketing fluff), not Backgammon Galaxy (purple gradient AI slop) or Nextgammon (SaaS dashboard feel)

### Competitive Positioning
Every backgammon platform clusters into two visual languages: casino (purple gradients, decorative) or SaaS tool (white dashboard, functional). Our aesthetic deliberately breaks from both. Dark felt + burgundy + gold says "premium club" and is instantly distinctive.

### Design Risks (intentional departures from category norms)
1. **Burgundy accent, not blue/purple/orange** — Every competitor uses blue, purple, or orange. Burgundy reads as "leather club" not "tech startup." Instantly distinctive.
2. **Gold reserved exclusively for verification** — When a user sees gold, it means "cryptographically verified." No gold decoration, no gold buttons. This creates a Pavlovian trust response on the audit page.
3. **Cinzel serif display font** — Unusual for gaming. Says "ancient game of strategy" not "Silicon Valley product." Reinforces the premium club positioning.

## Typography
- **Display/Hero:** Cinzel (serif) — Gravitas and intellectual tradition. Page titles, game headings, navigation labels.
- **Body:** Josefin Sans — Geometric sans that pairs well with Cinzel. All body text, descriptions, form labels.
- **UI/Labels:** Same as body (Josefin Sans)
- **Data/Tables:** Josefin Sans at smaller sizes, or JetBrains Mono for verification data
- **Code/Proofs:** JetBrains Mono — Any cryptographic data, hash, address, drand round, or verification code
- **Serif (Lux only):** Cormorant Garamond — Decorative display text in the luxury theme
- **Loading:** Google Fonts via `<link>` in layout.tsx. Inline script prevents FOUT.
- **Scale:**
  - Section labels: 0.6875rem (11px), uppercase, muted
  - Table/small text: 0.75rem (12px)
  - Body: 0.875rem (14px)
  - Subheadings: 1rem (16px)
  - Headings: 1.25rem (20px)
  - Page titles: 2rem (32px), Cinzel
  - Stat values: 1.5rem+ (24px+), Cinzel

## Color
- **Approach:** Restrained — Burgundy accent + gold verification on deep green-black. Color is rare and meaningful.

### Themes

| Theme | Background range | Accent | Text primary | Gold/Verification |
|-------|-----------------|--------|--------------|------------------|
| Dark (default) | `#040604` → `#2A3026` | `#581428` burgundy | `#ECE8E0` cream | `#D0A848` |
| Light | `#F5F1EB` → `#E0DCD4` | `#7A1830` burgundy | `#2A2418` dark brown | `#B08828` |
| Lux | `#2A0A16` → `#5A2238` | `#E8B84A` gold | `#ECE8E0` cream | `#E8B84A` |

### Semantic Colors
- Success: `#60A860` — Verified, win, positive outcomes
- Danger: `#CC4444` — Error, loss, destructive actions
- Warning: `#FBBF24` — Caution, pending states
- Info: `#5888A0` — Informational, neutral

### Dark mode
Dark is the default. Light mode adjusts surfaces, reduces saturation slightly, darkens accent. All via CSS variable overrides on `html.light` class.

## Spacing
- **Base unit:** 4px
- **Density:** Comfortable (competitive players want information density, not whitespace)
- **Scale:** 2xs(2) xs(4) sm(8) md(16) lg(24) xl(32) 2xl(48) 3xl(64)
- **Common patterns:** `px-6 py-4` for sections, `gap-4` between items, `gap-2` for tight groups

## Layout
- **Approach:** Grid-disciplined — Strict alignment, information-dense like Lichess
- **Grid:** Single-column mobile, two-column desktop for the audit page and analysis
- **Max content width:** Follows AppShell constraints (sidebar + main content)
- **Border radius:**
  - Cards/panels: 8px (`--radius-card`)
  - Buttons/inputs: 6px (`--radius-button`)
  - Pills/badges: 20px (`--radius-pill`)
  - Small elements: 6px (`--radius-sm`)

## Motion
- **Approach:** Intentional — The progressive verification cascade is the signature animation. Everything else is functional.
- **Signature:** Dice verification checkmarks cascade down the audit table at ~100ms intervals as BLS signatures verify live in the browser. This is honest theater, the verification IS happening.
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out)
- **Duration:** micro(50-100ms) short(150-250ms) medium(250-400ms) long(400-700ms)
- **Specific animations:**
  - `fade-in`: 300ms translateY ease-out (page/section entrance)
  - `dice-bounce`: 0.5s cubic-bezier(0.34,1.56,0.64,1) (dice roll result)
  - `checker-place`: 0.3s scale ease-out (checker landing)
  - `checker-fly`: arc path animation (checker movement)
  - `legal-pulse`, `dest-pulse`: game board interaction indicators
- **Reduced motion:** All animations respect `prefers-reduced-motion: reduce`

## Design Rules

1. **Gold = Verified.** Gold is reserved exclusively for verification and trust signals. No gold buttons, no gold decoration. When users see gold, it means "cryptographically verified."
2. **Burgundy = Action.** Primary buttons, active navigation, emphasis. The accent color.
3. **Monospace = Proof.** Any cryptographic data uses JetBrains Mono. If you can verify it, it gets monospace.
4. **CSS variables, not hex values.** Every color reference uses a variable so all three themes work.
5. **Dense but readable.** Match Lichess information density. Small font sizes (11-14px), tight spacing, no wasted whitespace.
6. **No generic card grids.** Custom layouts, not 3-column icon feature grids. Every screen earns its layout.
7. **SVG for data.** Equity graphs, dice faces, board elements, and any new visualizations use SVG.
8. **Cinzel for gravity.** Page titles and important headings use the display serif for the premium feel.

## Component Inventory

Located at `apps/backgammon-web/src/components/ui/`:

| Component | Variants | Notes |
|-----------|----------|-------|
| Button | primary, secondary, ghost, destructive + sm/md/lg | Uses burgundy accent |
| Card | padding: none/sm/md/lg | Surface background + shadow |
| Avatar | xs/sm/md/lg + online indicator | Player display |
| Badge | gold, win, loss, draw, default | Gold badge = verification |
| TextInput | label + error state | Focus shows accent border |
| SectionLabel | — | Uppercase, muted, small |
| PillGroup | — | Group of pill-style buttons |
| SegmentToggle | — | Toggle between options |
| TabBar | — | Navigation tabs |
| MatchRow | — | Match history with expand |
| PlayerRow | — | Player info display |
| StatCell | — | Single stat metric |
| FocusTrap | — | Accessibility modal wrapper |

## Audit Page Design

The differentiator. Two-column report layout:

```
┌───────────────────────────────────────────────┐
│ GAME SUMMARY: Players, score, date, cube, badge│
│ "32/32 rolls verified ✓" (gold)               │
├──────────────────┬────────────────────────────┤
│ DICE AUDIT       │ GNUBG ANALYSIS             │
│ (trust column)   │ (skill column)             │
│                  │                             │
│ Roll-by-roll     │ Equity graph (SVG)          │
│ table with       │ Stat boxes (error rate,     │
│ drand proofs     │ blunders, rating)           │
│ and ✓ badges     │ Move-by-move color-coded    │
│                  │ analysis                    │
├──────────────────┴────────────────────────────┤
│ SHARE BAR: Copy audit URL                      │
└───────────────────────────────────────────────┘
Mobile: stacked (dice audit above analysis)
Desktop: side-by-side columns
```

Progressive verification cascade: checkmarks appear at ~100ms intervals as client-side BLS verification runs per roll. Not fake animation, real cryptographic verification happening live.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-02 | Initial design system created | Formalized from existing codebase patterns by /design-consultation |
| 2026-04-02 | Gold = Verified rule | Gold reserved for cryptographic verification states only, creating Pavlovian trust response |
| 2026-04-02 | Two-column audit page | Trust (dice audit) and skill (GNUBG analysis) are different emotional needs, shown side-by-side |
| 2026-04-02 | Progressive verification cascade | Client-side BLS verification shown as cascading checkmarks. Honest theater, builds trust. |
| 2026-04-02 | Competitive positioning | Deliberately breaks from casino (Galaxy) and SaaS (Nextgammon) visual clusters |
