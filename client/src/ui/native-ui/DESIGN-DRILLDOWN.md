# DESIGN-DRILLDOWN — the battle UI's interaction framework

**Status:** U0 (framework + story-1 vertical slice) is built. U1–U4 implement
*inside* this; they add kinds, not mechanisms.

**Authority:** the USER DESIGN DIRECTIVE of 2026-08-29, recorded in
`.tasks/notes/battle-clarity.md` and in the `ui-drilldown-directive` memory. It
supersedes any earlier brief that adds an always-on panel. The verdict it came
from, after playing `crossing_standoff`:

> the current UI is cluttered and feels like driving a spreadsheet — to entice
> players we need a UI that stays out of the way until it is needed

and the governing principle:

> New players must not be swamped. Click/hover to explore the interface AND the
> world; if they see something interesting, one more click gets them there,
> including camera travel. **Depth on demand, never by default.**

This file is the mechanism all four interaction stories share. Read it before
adding anything to the battle HUD.

---

## 1. The one rule

**Nothing is on screen unless the player asked for it, or it is about to
change what they do next.**

Everything below is a consequence of that sentence. When a future decision is
genuinely ambiguous, resolve it by asking which of the two options a player who
has never seen this game would be able to ignore.

The corollary that is easy to forget: *removing* is the work. The directive was
prompted by a HUD that already had five panels, and every story below is
tempting to implement by adding a sixth. §7 is the audit of what has to go
first.

---

## 2. The ladder

Four rungs. A player climbs one rung per click, and every rung is escapable by
one Esc.

| Rung | What it is | Budget | Lives in |
|---|---|---|---|
| **0 — Ambient** | The two or three things that are true all the time | one pill, one minimap | fixed docks |
| **1 — Summary affordance** | Appears *with* the thing it describes, leaves *with* it | one line: a name, one state word, ≤3 numbers | floats, near the eye line |
| **2 — Context panel** | The detail for exactly one focused thing | ≤ 40vh, no scrolling document | hangs off its own rung-1 chip |
| **3 — Actions** | What you can DO about the focused thing | a row of buttons, always last in the panel | inside the rung-2 panel |
| **4 — Global surfaces** | Statistics, reports, events, objectives, diplomacy | anything — it is modal | **behind one access point** (§6) |

Two properties make it a ladder rather than a menu:

- **Every rung is reachable from the rung below in one click.** No rung is
  reachable in zero clicks except rung 0.
- **A rung never opens twice.** At most one rung-2 context panel exists
  (`FocusModel.drill` replaces, never stacks). Two open panels is a dashboard,
  and a dashboard is the spreadsheet.

### What a summary affordance may show

Rung 1 answers **"is this OK, and what is it doing?"** — nothing else.

Allowed:

- the thing's **name** (or, failing that, an honest count: "3 units");
- **one state word** — `moving`, `idle`, `tasked`, `contested`, `under fire`;
- **at most three numbers**, each of which a player can act on without reading
  a label twice. `SUMMARY_MAX_STATS = 3` in `drilldown.ts` **enforces** this:
  passing more truncates and warns. A cap that lives only in prose erodes one
  well-meaning field at a time.

Not allowed at rung 1, ever:

- a table, a list of more than one row, or a progress bar per item;
- any form control — a text field, a slider, a dropdown, a submit button;
- free text longer than the one line the chip occupies;
- a number whose meaning needs the label read ("Assigned 0.62").

Everything excluded above is legitimate content — one rung down.

### What rung 2 is for

The facts a player wants *after* deciding this thing is interesting: full
strength including the weakest member, class, roster, briefing text, reward and
penalty, time remaining, **and the places this thing references** (§5). Its
height is capped in CSS at `40vh` deliberately: a context panel that scrolls is
a resident data panel that has not admitted it yet, and belongs at rung 4.

---

## 3. Focus — the one source of truth

`focus-model.ts`. One module, read by the whole HUD and (story 4) by the
natural-language layer. Nothing else may hold "what is selected".

```ts
FocusState = {
  unitIds:      readonly number[]   // the raw selection, as the worker reports it
  subjects:     readonly FocusRef[] // what that selection MEANS
  drilled:      FocusRef | null     // the one open context panel
  openSurfaces: readonly string[]   // ids of open panels/overlays
}
```

A `FocusRef` is `{ kind, id, label, position?, unitIds?, data? }` where `kind`
is one of `squad · unit · town · enemy-force · objective · area` — the
directive's own vocabulary, plus the two primitives everything else decays to.
**A kind is added only when a rung-2 view exists for it**; a kind with no detail
view is a dead end the player can click into.

### Why this is not `uiStore.getSelection()`

The store holds the wire's answer to "what did the player click": a list of sim
unit ids. That is the right thing for a store and the wrong thing for a UI,
because none of the four stories are about unit ids. A player who box-selects a
squad has selected **one thing with a name**; "pull them back" needs a subject,
and a subject is what a name addresses; and an open objective panel is part of
the focus although no selection carries it.

So `resolveSelectionSubjects(unitIds, groups)` sits between them, with three
rules in this order:

1. **Exact roster ⇒ the group, by name.** Identical to
   `cost-preview.ts`'s `matchSelectionToGroup`, on purpose: the HUD and the
   order path must never disagree about what is selected.
2. **Partial roster ⇒ still the group, marked `partial`.** A player who
   box-selected four of six tanks is looking at 3rd Tanks; answering "4 units"
   is precisely the spreadsheet reading. The flag lets rung 1 say "4/6" and lets
   an order path refuse to treat it as the whole group.
3. **Everything left over ⇒ one anonymous `unit` ref.** Ungrouped units are
   real; they get a rung-1 chip and no invented name.

A selection spanning several groups yields several subjects. That is a truthful
answer, not an ambiguity to resolve here — whoever needs exactly one applies its
own tie-break with the full list in hand.

### How story 4 reads it

`focusModel.nlFocus()` returns **kinds and labels only — never ids, never
positions**. The NL envelope is name-addressed and `nl-resolver.ts` is what
turns a name into an id under rules the local path shares; an id shipped into
the model's view of the world is a resolver bypass, and the same argument
`nl-context.ts` makes for the census applies here unchanged.

The pronoun antecedent (`primary`) is:

```
drilled  >  the single subject, if there is exactly one  >  null
```

`null` is a real answer. "Pull them back" over two named groups has no single
referent, and inventing one is how a voice interface issues the wrong order —
the clarify path exists for exactly this.

**U4's job** is to add a `focus` field to `NLContext` fed from `nlFocus()`, and
to make the resolution visible ("Moving 3rd Tanks to Storm Sound") before the
order executes. U0 does not touch the NL layer.

### Lifetime

`bindSelectionToFocus(uiStore)` is installed by `integration.ts` at
`initializeNativeUI` and torn down in `disposeNativeUI`, alongside the widget
loader. It subscribes to **both** `selection` and `orgGroups`: a group renamed
or re-rostered under a live selection changes what that selection *means*, and
a model watching only the id list would show a stale name until the player
clicked elsewhere.

---

## 4. The drill-down container

`drilldown.ts`. One primitive; every drill-down surface in the game is a call to
it with different callbacks.

```ts
createDrilldown({
  ref,                       // the FocusRef this is about
  summary: () => ({ title, state?, stats? }),   // rung 1
  detail:  (host) => { … },                     // rung 2
  actions: () => DrilldownAction[],             // rung 3
  travel?,                   // where "go there" goes; default = ref
})  →  { el, expand, collapse, toggle, isExpanded, refresh, dispose }
```

Invariants the primitive **enforces**, so no caller can drift:

1. **≤ `SUMMARY_MAX_STATS` at rung 1**, truncate-and-warn past it.
2. **One open context panel**, arbitrated by the focus model — a drilldown that
   loses the drill (another chip clicked, or the selection changed under it)
   closes itself.
3. **Esc closes this and only this**, consumed in the capture phase so it never
   also reaches `main.ts`'s global Escape handler and opens the quit dialog
   behind the panel the player just closed. While collapsed it does not touch
   Escape at all, so Esc still quits.
4. **A collapsed drilldown holds no detail DOM and no subscriptions of its
   own.** A HUD of collapsed chips costs a HUD of chips.
5. **A disabled action carries its reason as a tooltip.** A greyed button with
   no explanation is the same dead end as a button that silently does nothing.

`detailRow(label, value)` and `detailReference(label, target, {note})` are the
two rung-2 builders, so every context panel in the game looks the same without
each caller re-inventing a definition list.

### Floating chips vs docked panels — the dividing line

> **If the player needs to know WHERE, it is an icon in the world.
> If they need to know WHAT, it is a surface at the edge.**

| | world-anchored icon | viewport-anchored surface |
|---|---|---|
| answers | "where is this?" | "what is this?" |
| examples | objective ring/beacon, off-screen combat ping, contact marker, minimap blip | the focus summary chip, a context panel, the global surfaces |
| owner | render worker (Babylon scene / ground decals) | `#ui-root` DOM |
| built by | **U2** (markers), **U3** (pings) | U0 (this file), U1, U3 |
| fade rule | must fade with camera distance and must never hide the fight under it | never overlaps the centre or lower-centre of the viewport |

A world icon is always *also* a rung-1 affordance: clicking it drills, exactly
like clicking a chip. That is what makes "explore by clicking the world" and
"explore by clicking the UI" the same interaction rather than two.

**Not built in U0:** world-anchored floating icons. They need the marker layer
U2 owns. Until then rung-1 affordances are viewport-anchored, and `focus-hud.ts`
docks its chip stack at `top-center` — the only dock that is both near the
player's eye line and outside the centre/lower-centre band the design system
reserves for selection gestures and orders.

---

## 5. Camera travel — "go there"

`camera-travel.ts`. Travel is a property of a **reference**, not a feature of a
panel: wherever a `FocusRef` is rendered, the same affordance appears, looks the
same, and runs the same code.

```ts
travelTo(target)                      // FocusRef | {x,z} | {unitId}
createGoThereButton(target, {onTravel})
canTravelTo(target)                   // drives every disabled state
```

**One path, and it is ground-anchored.** The camera has lived in the
game-processor worker since GW8; main reaches it only through `workerCall`,
which `CameraPort` wraps. Of the ops that port exposes exactly one frames a map
position against the **terrain**:

- `cameraSnapToGround(x, z, opts)` — samples the heightmap for its look-at.
  This is the one the test rig frames every shot with, and it is what
  `CameraPort.travelTo` and therefore the whole ladder rides.
- `focusOn(x, z, ms)` pans the look-at to `(x, 0, z)` — **sea level**. On any
  map with relief a travel arrives looking under the hill it was asked to show,
  and the further the travel the worse it reads. Not used for travel.
- `setCameraPose` is a raw pose the rig deliberately ignores. Never used here.
- `cameraSnapToUnit(id, opts)` resolves a unit's position worker-side and then
  calls `snapToGround`. This is how a squad is travellable the instant it is
  selected, before any census snapshot has arrived.

**No height is passed**, so `snapToGround` preserves the player's current
camera-to-look-at distance. Travelling somewhere keeps the zoom they chose; a
"go there" that also re-zooms is a camera the player has to fight back.

**Refusals are visible.** A ref with neither a position nor members renders the
button **disabled with a reason**, and `travelTo` returns
`{ok:false, reason:'no-target'|'no-camera'}`. A "go there" that quietly does
nothing teaches a new player that the UI is broken — the exact failure this
framework exists to remove.

`CameraPort.follow` (already built, already escapable three ways) is the
sustained form and is exposed as a rung-3 action.

---

## 6. The one global access point (story 3)

> Global battle options behind **one** access point: statistics, detailed
> reports, events, objectives, diplomacy.

**Design (U0) — not built (U3 builds it):**

- **One control**, in the `top-right` dock, next to nothing else. A single
  labelled button, plus one key binding (`Tab`).
- **It opens ONE surface**, centred and modal-ish, with a tab strip:
  `Statistics · Reports · Events · Objectives · Diplomacy`. Rung 4 is the one
  rung with no size budget, because it is the one rung the player is *only*
  looking at.
- **Registered in `ui-action-registry`** so "open the diplomacy panel" reaches
  the tab, not a rail panel, and so `focusModel.openSurface`/`closeSurface`
  record it — which is what lets story 4's "close that" bind to something.
- **Every entry in that list is forbidden from docking beside the viewport.**
  If a surface is in the rung-4 tab strip it is not also a rail panel. This is
  the rule that retires `scoreboard-panel`, `parley-panel` and
  `ai-command-panel` from the rails (§7).
- **The one permitted leak**: a single always-visible victory-condition line
  ("Raven Basin: contested — hold clock resets") as a rung-1 affordance that
  drills into the Objectives tab. It is rung 1 because it changes what the
  player does next; everything else in the list does not.

---

## 7. Audit of the existing HUD

Measured baseline (from the `metalstorm-hud-layout` lane, 1200×757): panel area
over viewport **≈9.3% at defaults, ≈20.4% with every panel expanded** — and that
9.3% is present whether or not the player is doing anything.

### Engine HUD — `client/src/ui/hud/hud.html`

| Element | Verdict | Why |
|---|---|---|
| `#hud-top-bar` (entities, frame) | **already folded** — hidden by default | correct as is |
| `#hud-speed` | **keep at rung 0** | already drill-down-correct: hidden at 1×/unpaused, visible only when it changes what the player expects |
| `#hud-selection` — "Selected: unit 42" / "Selected: 3 units" | **DEMOTE** | superseded by the rung-1 focus chip, which says the same thing with a *name*. A raw id readout is the definition of the spreadsheet. **Not removed in U0**: the engine HUD is shared with ZK/BAR and Metalstorm is the only game with a focus HUD, so the fold needs a per-game switch. **Filed for U1.** |
| `#hud-minimap` | **keep at rung 0** | spatial, not tabular; it is the one always-on surface that answers "where" |
| `#detach-minimap-btn` ("Pop out ↗") | **DEMOTE** | a permanent chrome button for a rare action. Should appear on hover over the minimap. Cosmetic; unscheduled. |
| `#hud-help` — "Left click: select · Right click: move…" | **DEMOTE** | permanent onboarding text that never goes away and is read once. Should be first-session-only (the onboarding lane already gates on `sessions_played`) or live behind the rung-4 access point. **Filed for U3** with the rest of the guidance surfaces. |

### Metalstorm native-UI panels — `data/games/metalstorm/ui/metalstorm.ui.json`

| Widget | Now | Verdict |
|---|---|---|
| `authority-bar` | top-left pill, always on | **KEEP at rung 0** — already key-numbers-only (YOU / TEAM). Should gain a rung-2 drill (the authority ledger) instead of pushing its event ring at the player as toasts. Unscheduled. |
| `objectives-panel` | right rail, **expanded by default**, contains a bounty *form* | **DEMOTE to rung 1 + 2.** A resident list with a form beside the viewport. Its content is exactly story 2's. **U1 owns this**, and the brief already says to expect to demote rather than extend. |
| `scoreboard-panel` | right rail, collapsed | **FOLD to rung 4** — "statistics". Off the rail entirely. |
| `parley-panel` | left rail, collapsed | **FOLD to rung 4** — "diplomacy". Off the rail entirely. |
| `ai-command-panel` | left rail, collapsed, tallest panel in the HUD | **FOLD to rung 4** — "reports"; its change feed is "events". Off the rail entirely. |
| `command-composer` | bottom-centre, expanded: `[VERB] [SUBJECT] [TARGET] [WHEN]` chips + a priority slider + a commit button | **RETIRE.** This is the spreadsheet, literally: a four-slot form for issuing one order. Superseded by rung-3 actions (context-specific, no slots) and by story 4's sentence. **U4's call to remove**, because U4 is what replaces it; flagged here so it is a decision and not an oversight. |
| `command-console` | bottom-centre, resident transcript | **DEMOTE to summonable.** The mechanism is right and stays; being *resident* is wrong. **U4** makes it one key to open, out of the way when closed. |
| `focus-hud` | top-centre, **nothing in the DOM until something is selected** | new in U0 — the reference implementation of rung 1/2/3 |

### The resting HUD this audit targets

After U1–U4 land the audit above, a player who has selected nothing and opened
nothing sees: **the authority pill, the minimap, the global access point, and
the victory-condition line.** Both rails are empty. Everything else arrives
because the player pointed at something.

---

## 8. The story-1 vertical slice (U0's proof)

`focus-hud.ts` — the whole ladder end to end on the player path, one kind only:

```
select a squad  →  a chip appears at top-centre:  3rd Tanks · IDLE · Units 6 · Str 84%
                →  click it  →  Roster / Class / Strength / Position / Near
                →  actions: Halt · Follow
                →  click "Go there" on Position or Near  →  the camera travels
```

Data comes from the **NL census** (`nlCensus` via `censusCacheHolder`) — the same
LOS-honest unit mirror the command language reads, so the HUD and a sentence can
never disagree about a squad's state. `health` and `moving` were added to that
op for this: both were already on the worker's unit mirror
(`UnitEntry.healthRatio`, the velocity triple), so the summary costs no new
stream. The census is pulled on selection change and then at 1 Hz **while a
selection exists, and not at all otherwise** — `PLAN-native-ui.md` forbids
per-frame DOM mutation.

### Deliberately not in U0

- **World-anchored floating icons** — need U2's marker layer.
- **The rung-4 global access point** — designed in §6, built by U3.
- **Objective / town / enemy-force kinds** — U1, U2, U3 respectively. Each is a
  `createDrilldown` call, not a new mechanism.
- **A selection port.** Rung 3 cannot yet offer "select the whole squad" for a
  partial selection: changing the *client* selection needs the worker's
  `selectUnits` op, and the only main-thread channel to it today is
  `CameraPort`'s `workerCall`, whose header explicitly forbids carrying
  non-camera verbs. A small `SelectionPort` alongside `CameraPort` is the right
  shape. **Filed for U1.**
- **Demoting anything in §7.** U0 adds the framework and removes nothing, so
  that the removals land with the replacements that justify them.

---

## 9. Checklist for anyone adding to the battle HUD

1. Which rung is this? If the answer is "rung 0", say why the player cannot
   ignore it.
2. If it is rung 1: does it fit in a name, a state word and ≤3 numbers? If not,
   what goes down to rung 2?
3. Does it go through `focusModel`, or does it hold its own idea of what is
   selected? (It must not.)
4. Does it use `createDrilldown`, or is it a second expanding thing? (It must
   not be.)
5. Does every place it names carry `createGoThereButton`?
6. Is it in the DOM when nothing is happening? (It must not be.)
7. What did you REMOVE?
