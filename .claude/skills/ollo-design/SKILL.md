---
name: ollo-design
description: ollo.art's design system — tokens, primitives, copy voice and the screenshot loop. Load before writing or changing ANY UI in this repo (components, pages, CSS, copy). Pairs with the frontend-design skill.
---

# ollo design system: bronze and verdigris

ollo is an AI image generator. The user's image is the hero: it sits on the plinth and everything else steps back. The identity comes from the bronze, laurel-crowned crow (`src/assets/treasure_crow.png`) and the laurel mark: cast bronze, patina, a museum after hours. The approved board is https://claude.ai/artifact/RpNXZFfnigpZP5HAyyXaGQ.

Also load `frontend-design` (in `.claude/skills/`) for general craft. Where they differ, this file wins.

## Tokens (`src/index.css`)

Two finishes of one identity: **Night** (default, dark) and **Plaster** (light, follows the OS, or an explicit `data-theme` on `<html>` via `useTheme().setFinish`). Never hard-code a colour; use the Tailwind token classes.

| Role | Class | Use |
|---|---|---|
| Page | `bg-background` / `bg-ground` | page ground |
| Surface | `bg-card` / `bg-stone` | bars, cards, sheets, dialogs |
| Inset | `bg-muted` / `bg-stone-2` | inputs, pills, hovered rows |
| Text | `text-foreground`, `text-muted-foreground` | body, secondary |
| **Bronze** | `bg-primary text-primary-foreground`, `text-bronze` | ONLY the action that spends credits or commits a flow (Generate, Continue to payment), plus the laurel |
| **Verdigris** | `text-verdigris`, `bg-verdigris`, `ring` | progress, success, selection, focus |
| Danger | `text-destructive` | destructive actions and errors |
| Lines | `border-border` | all dividers and outlines |

Fonts: `font-display` (Marcellus) for the wordmark, ONE page/section title per screen, and prices only. Everything else is `font-sans` (Hanken Grotesk). Never set Marcellus below 20px or in bold.

Radius by role: controls `rounded-lg` (10px), surfaces `rounded-2xl` (16px), pills `rounded-full`, images `rounded-xl`. Don't give every block the same radius and shadow; borders and fills mark separate objects, so use them only where an element must stand apart.

Legacy names (`--bg-primary`, `--accent`, `--text-secondary`, `.cyber-card`, `.cyber-button`…) are mapped onto the tokens in `index.css`/`App.css` so un-rebuilt screens still match. **Don't use them in new code**; delete them from a component when you rebuild it.

## Primitives (`src/components/ui`, shadcn/ui on Base UI)

Use these instead of hand-rolling: `Button` (`default` = bronze, `outline` = secondary, `ghost` = quiet, `destructive`), `Input`, `Textarea`, `Dialog`, `Sheet` (side or bottom), `Drawer`, `DropdownMenu`, `Popover`, `Select`, `Tabs`, `Tooltip`, `Badge`, `Skeleton`, and `toast` from `sonner` (the `<Toaster>` is mounted in `main.tsx`). Base UI composes with `render={<Button …/>}` on triggers, not `asChild`.

Brand pieces (`src/components/brand`): `Laurel` (static mark, or `progress={0..1}` gilds from the base up: use it for generation progress), `Wordmark`, `CreditPill` (balance chrome; clickable opens billing; bronze dot when low).

Add a primitive with `bunx --bun shadcn@latest add <name>`, then restyle it onto the tokens. Check every new file imports `cn` from `@/lib/utils` and uses no colour literals.

Dialogs and sheets get focus trapping, Escape and focus return from Base UI. Don't wrap them in your own key handlers.

## Layout rules

- The image is the largest thing on every screen it appears on. Chrome is quiet: no gradients, glows, sparkles, emoji, or ALL-CAPS labels.
- Prompt bar: one bar, settings as pills/popover; the Generate button always shows its cost ("Generate · 2 credits"). Bottom-docked on phones.
- Threads are **series**: each step shows its image and the instruction that produced it. Not chat bubbles.
- Loading tiles hold their final aspect ratio; use `Laurel progress` or `Skeleton`, never spinners over blank space.
- Out of credits: a bottom `Sheet` over the user's work with the shortfall, one recommended plan and one top-up. Never a redirect, never a raw error string.
- Mobile first: every screen must work at 390px with a 16px gutter and no horizontal scroll; tap targets ≥ 40px.
- Motion only responds to the user's action (opening, confirming, progress). No ambient animation. Respect reduced motion (global rule in `index.css`).

## Copy voice

Plain, specific, sentence case, written from the user's side. Buttons say exactly what happens ("Move to Trash", toast "Moved to Trash"). Errors say what happened and what to do ("This model needs 10 credits and you have 6." + "Top up"). No apologies, no "Oops", no "magic", no "divine". Name costs in credits and plans in dollars. Never show internal numbers (platform cost, API limits).

Server errors carry a machine-readable `code` (`INSUFFICIENT_CREDITS`, `MODEL_NOT_ALLOWED`, `MONTHLY_COST_LIMIT`, `GENERATION_TIMEOUT`, …). Branch UI on `code`, never on message text.

## Screenshot loop (required before calling UI work done)

```bash
bunx vite --port 5191 &            # frontend; `bun run dev` for full stack
bun scripts/shoot.ts http://localhost:5191 shots/<task> / /pricing   # 390px + 1440px
```
Use Playwright's `colorScheme: "light"` to check Plaster too (see `/styleguide`, dev-only, for every primitive). Look at the screenshots, fix what's off, then shoot once more. Check: nothing clipped or overlapping, no horizontal scroll at 390px, focus visible, both finishes legible, and nothing bronze that doesn't spend credits.
