# Metalstorm art direction — of record

Authored 2026-09-17 (PLAN-beta.md "Design decisions — presentation",
PLAN-beta-presentation.md §A). Binding on every presentation lane. Extends
`STYLE.md`'s model register — where the two disagree, this page wins for
*surfaces, light, FX and UI*; STYLE.md still owns geometry and tri budgets.

**Premise.** Post-collapse scavenger armies fighting over a dust bowl.
Everything is field-repaired, sun-bleached, oil-stained. Nothing glows unless
it is hot or powered. Readability is preserved by **value contrast and
silhouette**, never by saturation. "Gritty realism, still readable" is the
whole target; a treatment that costs a read is wrong however good it looks.

**Typography.** Display: *Barlow Condensed* 600/700, uppercase, tracked +4% —
stencil feel without novelty. Readouts and numbers: *IBM Plex Mono* 400/500.
Prose: *Barlow* 400. All OFL, self-hosted woff2 (latin subset, `font-display:
swap`), licensed in `ASSETS.md` § Fonts.

**UI metaphor — ONE: stencilled steel plate.** Panels are matte steel with a
1px chalk hairline, corner rivets only on top-level panels, hazard-stripe
accents only on destructive actions. Readouts are phosphor-cyan on near-black
recessed "glass". No radius above 2px, no gradients except a 3% top-lit
sheen, no drop shadows — a 1px dark inset edge instead. Grime overlay 6–10%
on large panels only. Team colours keep their identity but are desaturated
20% in chrome.

**Lighting/atmosphere.** Low warm sun, cool blue-grey ambient, aerial
perspective towards a desaturated horizon; contrast 1.15, exposure 0.9; bloom
only above 1.2; SSAO on High.

**FX.** Cold tracers (pale straw, thin, short), dim brief muzzle light, dust
before fire, smoke that lingers and drifts on a global wind vector, ground
scarring that stays. Explosions are dirt-heavy and brown, not orange balls.

**Audio.** Dry close reports with a distant low-passed tail; per-family
layering (transient + body + tail); a wind/dust bed at all times; UI clicks
are radio-filtered mechanical relays; music sparse, low, percussive.

## Palette

The register. Implemented verbatim as the `--ms-*` raw layer of
`client/src/ui/native-ui/tokens.css`; every UI colour is a `--nui-*` semantic
alias of one of these. Nothing outside `tokens.css` may name a colour.

| Role | Name | Hex | Used for |
|---|---|---|---|
| Ground | olive-drab | `#3d3a2e` | terrain base, vehicle field green |
| Ground | dust khaki | `#6b5a3e` | dust, dirt, spoil, low ground |
| Ground | bleached bone | `#8a7f6a` | sun-bleached concrete, horizon haze |
| Metal | worn steel | `#2b2e31` | panel plate, unpainted metal |
| Metal | scuffed steel | `#5a5f63` | lit edges, rivets, raised controls |
| Metal | rust | `#7a3b1e` | corrosion, wear, damaged plate |
| Accent | hazard yellow | `#c9a227` | warning, selection, mission-critical |
| Accent | chalk stencil | `#d8dcd6` | text and hairlines on steel |
| Signal | hot orange | `#e0561f` | damage and fire ONLY |
| Signal | phosphor cyan | `#7fd0c8` | readouts, powered/emissive things |
| Signal | dried-blood red | `#9a2f2f` | hostile, failure, destructive |
| Signal | signal green | `#8fae5a` | nominal/complete (derived 2026-09-17: the §A register carried no "good" hue and colour-only good/bad needs two) |

Text tints of the two signal reds/greens are lightened for contrast against
steel (`--nui-bad`, `--nui-good`); the fills stay as tabled above.
