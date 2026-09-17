# UI style — stencilled steel plate

One metaphor, one token file. Full art direction: `data/games/metalstorm/art/DIRECTION.md`.
Full token definitions: `client/src/ui/native-ui/tokens.css`. Every UI stylesheet
in the tree spends `--nui-*` tokens and names no colour of its own —
`tokens.test.ts` fails a build that adds a raw hex literal back.

## Token table (semantic tokens only — `tokens.css` also holds the raw `--ms-*` register, never referenced outside that file)

| Token | Use |
|---|---|
| `--nui-plate-color` / `--nui-plate` | The panel surface: `background-color` + `background-image`, always both — `background: var(--nui-bg)` alone drops silently, it is `<color> <gradient>`. |
| `--nui-bg-head` / `-sunken` / `-raised` / `-hover` | Surfaces a step darker (readout glass) or lighter (hover, raised control) than the plate. |
| `--nui-bg-float` | Floating panels over the 3D scene (menus, chips) — dimmed plate, world reads through. |
| `--nui-hairline` / `-border` / `-border-hi` / `-border-sunken` | Chalk lines, three weights. A hairline is always chalk-on-steel, never a lighter steel. |
| `--nui-border-swatch` | Plain black ring on a team/faction colour swatch — the only border that reads over an arbitrary hue. |
| `--nui-edge` / `-edge-sunken` | The ONLY depth cue. Raises or recesses via a 1px inset shadow — never a drop shadow. |
| `--nui-text` / `-dim` / `-faint` / `-bright` / `-on-accent` | Chalk text, four weights, plus the dark tint for text on an accent/gold fill. |
| `--nui-accent` / `-accent-dim` / `-accent-wash` | Phosphor cyan — reserved for anything powered and reporting: readouts, the affirmative action. |
| `--nui-gold` / `-gold-wash` | Hazard yellow — warning, selection, mission-critical. Never decorative. |
| `--nui-good` / `-bad` (+ `-fill`, `-wash`) | Status text tints and their tabled fill/wash colours. |
| `--nui-hazard-stripe` | The ONE destructive-action treatment: a stripe down the left edge. |
| `--nui-rivet` | Four corner dots on TOP-LEVEL panels only — not on nested rows or list items. |
| `--nui-radius` | 2px. The only radius in the system; pills/circles are shapes, not corners. |
| `--nui-family-display` / `-text` / `-mono` + `--nui-font-*` | Barlow Condensed (stencil headers), Barlow (prose), IBM Plex Mono (readouts). |

## Metaphor rules

1. **Nothing glows unless it is hot or powered.** A primary action is a
   phosphor-bordered plate, not a coloured slab — see `.nui-btn--primary` in
   `native-ui.css`.
2. **Depth is one inset edge**, never a drop shadow. A floating overlay over
   the 3D scene gets `--nui-bg-float` + `--nui-edge`, not a shadow to lift it.
3. **Rivets mark a top-level panel**, once, at the four corners. A list row
   or a nested card never gets them — that is what would make them stop
   reading as structural.
4. **Hazard stripe = destructive, and only destructive.** If a second thing
   on screen wants the stripe, that thing is not actually destructive.
5. **Radius stays at `--nui-radius` (2px).** A circle or a pill (an avatar,
   a status dot) is a deliberate shape, not a rounded corner, and is exempt.

## Icons

`client/public/ui/icons.svg` — 24 line glyphs (unit classes, objective
markers, stances, menu tabs), one `<symbol>` each, stroke-only so they take
`color` from the usage site: `--nui-text` at rest, `--nui-gold` for the
hazard/selected state. `<svg><use href="/ui/icons.svg#icon-tank"/></svg>`.

## Do / don't

- Do: `background-color: var(--nui-plate-color); background-image: var(--nui-plate);`
- Don't: `background: var(--nui-bg);` — silently invalid, paints transparent.
- Do: a hairline border (`--nui-hairline`) to separate a raised control.
- Don't: a second steel tone as a border — reads as another panel, not a line.
- Do: gate a destructive action behind `--nui-hazard-stripe` on the left edge.
- Don't: red-fill a whole destructive button — one stripe says it; a slab shouts it.
- Do: keep team colours identifiable, desaturated ~20% in chrome only.
- Don't: invent a new hue for a "special" state — reuse gold (mission-critical)
  or accent (powered/active); a new colour is a new thing to learn.
