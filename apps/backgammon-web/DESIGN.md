# Backgammon Web Design System

## Identity

A competitive backgammon platform that feels like a premium club, not a crypto app. The aesthetic is dark felt tables, burgundy leather, gold accents. Serious about the game, not about the blockchain.

## Themes

Three themes, all sharing the same CSS variable names with different values:

| Theme | Vibe | Background | Accent | Display font |
|-------|------|------------|--------|-------------|
| **Dark** (default) | Green felt table | `#040604` → `#2A3026` | Burgundy `#581428` | Cinzel |
| **Light** | Warm parchment | `#F5F1EB` → `#E0DCD4` | Burgundy `#7A1830` | Cinzel |
| **Lux** | Luxury club | Burgundy `#2A0A16` → `#4A1A2E` | Gold `#E8B84A` | Cormorant Garamond |

Theme is stored in `localStorage` key `gammon-theme`. Applied via class on `<html>` element. Inline script in `layout.tsx` prevents flash.

## Colors (CSS Variables)

### Background tiers
```
--color-bg-deepest    Darkest background (page-level)
--color-bg-base       Primary background
--color-bg-surface    Card/panel backgrounds
--color-bg-elevated   Raised elements (dropdowns, modals)
--color-bg-subtle     Hover states, subtle fills
```

### Text hierarchy
```
--color-text-primary    Body text, headings
--color-text-secondary  Supporting text, descriptions
--color-text-muted      Labels, captions
--color-text-faint      Disabled text, timestamps
```

### Accent (burgundy by default, gold in lux)
```
--color-gold-primary    Primary accent (buttons, links, active states)
--color-gold-light      Hover state for accent
--color-gold-dark       Pressed state for accent
--color-gold-muted      Subtle accent backgrounds
--color-accent-fg       Text on accent backgrounds
```

### Semantic
```
--color-success         #60A860  Verified, win, positive
--color-danger          #CC4444  Error, loss, destructive
--color-warning         #FBBF24  Caution, pending
--color-info            #5888A0  Informational, neutral
```

### Analysis (post-game, audit pages)
```
--color-analysis-gold         Primary analysis accent
--color-analysis-gold-light   Graph highlights
--color-analysis-gold-subtle  Stat backgrounds
--color-analysis-gold-faint   Subtle fills
```

### Board-specific
```
--color-board-felt-light    Light triangle fill
--color-board-felt-dark     Dark triangle fill
--color-board-point-light   Light point (#D4A86A)
--color-board-point-dark    Dark point (#8B4513)
--color-checker-white       White checker face
--color-checker-black       Black checker face (burgundy)
--color-die-white-*         White dice (face, stroke, dot)
--color-die-black-*         Black dice (face, stroke, dot)
```

## Typography

| Role | Font | Usage |
|------|------|-------|
| Display | `--font-display` Cinzel (serif) | Page titles, game headings, navigation labels |
| Body | `--font-body` Josefin Sans | All body text, descriptions, form labels |
| Mono | `--font-mono` JetBrains Mono | Hex values, drand proofs, addresses, code |
| Serif | `--font-serif` Cormorant Garamond | Lux theme display text, decorative use |

Font sizes follow browser defaults. No custom scale defined. Common patterns observed in codebase:
- Section labels: `0.6875rem` (11px), uppercase, `--color-text-muted`
- Table text: `0.75rem` (12px)
- Body text: `0.875rem` (14px)
- Stat values: `1.5rem+` (24px+), `--font-display`

## Spacing & Radius

```
--radius-card      8px     Cards, panels
--radius-button    6px     Buttons, inputs
--radius-pill      20px    Tags, badges, pills
--radius-sm        6px     Small elements
--radius-md        10px    Medium elements
--radius-lg        14px    Large elements
--radius-xl        20px    Extra large elements
```

Common spacing patterns: `px-6 py-4` for sections, `gap-4` between items, `gap-2` for tight groups.

## Shadows

```
--shadow-card       0 2px 12px rgba(0,0,0,0.3)     Cards, panels
--shadow-elevated   0 8px 32px rgba(0,0,0,0.4)     Modals, dropdowns
--shadow-gold       0 2px 12px rgba(88,20,40,0.3)  Accent-highlighted cards
--shadow-glow       0 0 60px rgba(88,20,40,0.12)   Ambient accent glow
```

## Component Inventory

Located at `src/components/ui/`:

| Component | Variants | Notes |
|-----------|----------|-------|
| Button | primary, secondary, ghost, destructive + sm/md/lg | Main CTA component |
| Card | padding: none/sm/md/lg | Container with shadow |
| Avatar | xs/sm/md/lg + online indicator | Player display |
| Badge | gold, win, loss, draw, default | Status/label |
| TextInput | label + error state | Form input |
| SectionLabel | — | Uppercase muted label |
| PillGroup | — | Group of pill buttons |
| SegmentToggle | — | Binary/multi toggle |
| TabBar | — | Navigation tabs |
| MatchRow | — | Match history row |
| PlayerRow | — | Player info display |
| StatCell | — | Single stat display |
| FocusTrap | — | Accessibility modal wrapper |

## Layout

- **AppShell**: Sidebar (desktop) + MobileNav (mobile) + main content area
- **Header**: Back button + title + subtitle + action slot
- **Sidebar**: Icon nav with active state (left border + background), badge support
- Breakpoint: Sidebar visible on desktop, MobileNav on mobile (no explicit breakpoint token, follows Tailwind defaults)

## Animations

```
fade-in         300ms translateY ease-out       Page/section entrance
spin            1s linear                       Loading spinners
dice-bounce     0.5s cubic-bezier(0.34,1.56)   Dice roll result
checker-place   0.3s scale ease-out             Checker landing
checker-fly     arc path                        Checker movement
legal-pulse     pulsing                         Legal move indicators
dest-pulse      pulsing                         Destination highlights
```

All animations respect `prefers-reduced-motion: reduce`.

## Design Principles for New Screens

1. **Use CSS variables, not hex values.** Every color reference should use a variable so themes work.
2. **Monospace for proofs.** Any cryptographic data, hash, address, or verification code uses `--font-mono`.
3. **Cinzel for gravity.** Page titles and important headings use `--font-display` for the club/premium feel.
4. **Gold = success/verified.** The analysis-gold palette is for positive verification and achievement states.
5. **Burgundy = action.** Primary buttons, active nav, emphasis.
6. **Dense but readable.** The existing UI is information-dense (small font sizes, tight spacing). New screens should match this density, not add whitespace.
7. **No generic card grids.** The UI uses custom layouts, not 3-column feature grids.
8. **SVG for data visualization.** Equity graphs, dice faces, and board elements are all SVG. Use SVG for any new charts or visualizations.
