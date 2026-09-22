# Design System

Neomorphism is the primary surface language everywhere. Liquid Glass is an accent used only on: the search bar, the primary send/action button, and floating controls — never the whole interface. See `design-preview.html` for this rendered, not just described.

## 1. Color

Strictly black, white, red, green, blue by default; one custom accent available in Settings. Functional only — never decorative.

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--surface` | `#E9EBF0` | `#1C1D22` | Base neomorphic surface |
| `--shadow-light` | `#FFFFFF` | `#2A2C34` | "Raised" highlight edge |
| `--shadow-dark` | `#B9BCC7` | `#101115` | "Raised" shadow edge |
| `--text` | `#1B1C21` | `#F2F2F5` | Primary text |
| `--text-dim` | `#6B6D76` | `#9A9CA6` | Secondary text |
| `--red` | `#E5484D` | same | Errors, destructive actions, delete, disconnect, security warnings |
| `--green` | `#22C55E` | same | Typing indicator, online status, success |
| `--blue` | `#3B82F6` | same | Read receipts / double-tick, links, selected state |
| `--accent` (user-selectable) | — | — | Replaces blue-role accents where a user has picked one; default theme never shows this |

**One flagged deviation, deliberately, not silently:** the "white" and "black" surfaces above are `#E9EBF0` and `#1C1D22`, not literal `#FFFFFF`/`#000000`. True neomorphism needs a mid-contrast base for the dual-shadow depth effect to read at all — against pure white or pure black, the raised/pressed shading becomes nearly invisible. This is still unambiguously a black-and-white system; check `design-preview.html` and tell me if you want it pushed closer to literal pure black/white (the shadow contrast gets subtler if so).

## 2. Neomorphic surface recipe

Two elevation states, both built from the same two shadows in different directions:

```css
.neo-raised {
  background: var(--surface);
  border-radius: 18px;
  box-shadow: 8px 8px 16px var(--shadow-dark), -8px -8px 16px var(--shadow-light);
}
.neo-pressed {
  background: var(--surface);
  border-radius: 18px;
  box-shadow: inset 4px 4px 8px var(--shadow-dark), inset -4px -4px 8px var(--shadow-light);
}
```

Border radius scale: `10px` (small controls) / `14px` (inputs, chips) / `18–20px` (cards, bubbles, sheets). Rounded, not pill-shaped, except small icon-only buttons — matches "rounded but not excessively rounded."

## 3. Liquid Glass recipe

```css
.glass {
  background: rgba(255,255,255,0.55);   /* dark mode: rgba(28,29,34,0.55) */
  backdrop-filter: blur(20px) saturate(160%);
  border: 1px solid rgba(255,255,255,0.6);   /* dark mode: rgba(255,255,255,0.12) */
  box-shadow: 0 8px 24px rgba(0,0,0,0.12);
}
```

Applied to exactly: the search bar, the message-composer send button, and any floating primary action. A thin top highlight (a soft diagonal light gradient at low opacity, not a rainbow) is what makes it read as "glass catching light" rather than just "blurred box" — this is the one place the design is allowed to be a little more expressive, precisely because everywhere else stays quiet.

## 4. Typography

**Inter** for UI text (display and body both — one characterful, restrained grotesque rather than the raw system-font stack), with a system-ui fallback stack for instant load. Scale: 13 / 15 / 17 / 22 / 28px, restrained weight range (400/500/600) — no huge display type, matching "Apple-like simplicity" over "marketing site."

## 5. Component inventory (built for real in Phase 1)

Auth (create/login) · Pairing (generate/enter code, duration picker) · Chat list · Chat conversation (bubbles, composer, header) · Search bar (+ hidden-chat entry point) · Settings (all subsections from the brief) · Disappearing-message timer picker · App-lock screen (PIN pad + biometric prompt) · Media viewer.

## 6. Accessibility — the honest part

Neomorphism has a well-known, legitimate critique: soft, low-contrast shadows are exactly the kind of thing that can hurt legibility and make interactive elements hard to distinguish from static ones. Mitigations built into the token system rather than left as an afterthought:

- Text contrast is checked against WCAG AA independent of the shadow effect — the shadow decorates depth, it never carries the text/background contrast on its own.
- Interactive elements get a visible focus ring (not shadow-only affordance) for keyboard navigation.
- Minimum touch target 44×44px regardless of visual size.
- `prefers-reduced-motion` is respected — transitions collapse to instant or near-instant.
- Color is never the only signal (e.g., the read-receipt tick pairs blue with a shape change, not blue alone) — relevant given ~1 in 12 men have some form of red-green color vision deficiency, and this palette leans on red/green for meaningfully different states.

## 7. Responsive

Mobile-first (this is fundamentally a phone chat UI), single column throughout; tablet/desktop get a max content width with generous margins rather than a stretched two-pane layout that doesn't fit "small, private, minimal."
