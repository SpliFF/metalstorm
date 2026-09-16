// ui/lib/focus.js — the session FOCUS as a game-dir widget (or the NL layer)
// may read it. Pure logic, no DOM, no imports.
//
// ── Where the truth lives ──
//
// The focus model itself is `client/src/ui/native-ui/focus-model.ts` — ONE
// source of truth for "what is selected / drilled / hovered / open", fed by the
// selection mirror and every drill-down surface (DESIGN-DRILLDOWN.md §3:
// "nothing else may hold what is selected"). This file deliberately holds NO
// state of its own. It is the read contract: the shape the model projects for
// anything outside the client bundle (`focusModel.nlFocus()`, handed to
// game-dir widgets as `ctx.focus.get()`), plus the small pure helpers that
// read that shape the same way everywhere.
//
// A widget fetched from the game dir as a standalone ES module cannot import
// the bundled model, which is why the loader passes a PORT (`ctx.focus`) and
// why this file exists beside the other `lib/*.js` contract mirrors.
//
// ── The shape (`FocusView`) ──
//
//   {
//     primary:  FocusBrief | null   // the pronoun antecedent — see primaryOf()
//     subjects: FocusBrief[]        // what the world selection MEANS
//     drilled:  FocusBrief | null   // the one open context panel
//     hovered:  FocusBrief | null   // the chip under the pointer, if any
//     openSurfaces: string[]        // ids of open panels/overlays, oldest first
//     selectionCount: number        // raw selected unit count
//   }
//
//   FocusBrief = { kind, label, place? }
//     kind:  'squad' | 'unit' | 'town' | 'enemy-force' | 'objective' | 'area' | 'ai'
//     label: what the player is shown and what a sentence may call it
//     place: the NAME of where it is, when known ("Raven Basin") — what
//            "defend it" binds to. A name, never a position.
//
// NO IDS AND NO COORDINATES cross this seam, on purpose: the NL envelope is
// name-addressed, the resolver turns a name into an id under rules the local
// path shares, and an id shipped through here is a resolver bypass.

/** Every kind a brief may carry. Exported so a consumer can validate. */
export const FOCUS_KINDS = Object.freeze([
  'squad', 'unit', 'town', 'enemy-force', 'objective', 'area', 'ai',
]);

/** A view with nothing focused. Frozen; safe to hand out as a default. */
export const EMPTY_FOCUS = Object.freeze({
  primary: null,
  subjects: Object.freeze([]),
  drilled: null,
  hovered: null,
  openSurfaces: Object.freeze([]),
  selectionCount: 0,
});

/** Structural check for a `FocusBrief`. */
export function isFocusBrief(b) {
  return !!b && typeof b === 'object'
    && FOCUS_KINDS.includes(b.kind)
    && typeof b.label === 'string'
    && (b.place === undefined || typeof b.place === 'string');
}

/** Structural check for a `FocusView` — what `ctx.focus.get()` must return. */
export function isFocusView(v) {
  if (!v || typeof v !== 'object') return false;
  if (!Array.isArray(v.subjects) || !v.subjects.every(isFocusBrief)) return false;
  if (!Array.isArray(v.openSurfaces) || !v.openSurfaces.every((s) => typeof s === 'string')) return false;
  if (typeof v.selectionCount !== 'number') return false;
  for (const key of ['primary', 'drilled', 'hovered']) {
    if (v[key] !== null && v[key] !== undefined && !isFocusBrief(v[key])) return false;
  }
  return true;
}

/**
 * The one thing a deictic word ("it", "them", "this one") means right now.
 *
 * The model's own `primary` is `drilled > the single subject > null`, and
 * hover is deliberately NOT folded into it there: a pointer resting on a chip
 * while the player types is weaker evidence than a panel they opened. This
 * helper is the documented place a consumer opts hover in, and the order is:
 *
 *   drilled  >  hovered (only when `preferHover`)  >  the single subject  >  null
 *
 * `null` is a real answer — two selected groups have no single "it".
 */
export function primaryOf(view, { preferHover = false } = {}) {
  if (!view) return null;
  if (view.drilled) return view.drilled;
  if (preferHover && view.hovered) return view.hovered;
  if (view.primary) return view.primary;
  return view.subjects && view.subjects.length === 1 ? view.subjects[0] : null;
}

/** The place a sentence's "there" / "it" binds to, or null. */
export function placeOf(view, opts) {
  const p = primaryOf(view, opts);
  if (!p) return null;
  if (p.place) return p.place;
  return p.kind === 'town' || p.kind === 'area' ? p.label : null;
}

/** One line of prose: "3rd Tanks (open)", "nothing selected", "A, B". */
export function describeFocus(view) {
  if (!view) return 'nothing selected';
  if (view.drilled) return `${view.drilled.label} (open)`;
  const subjects = view.subjects ?? [];
  if (subjects.length === 0) return 'nothing selected';
  if (subjects.length === 1) return subjects[0].label;
  return subjects.map((s) => s.label).join(', ');
}

/** True while surface `id` is recorded open. */
export function isSurfaceOpen(view, id) {
  return !!view && Array.isArray(view.openSurfaces) && view.openSurfaces.includes(id);
}

/**
 * The focus port a widget should use: `ctx.focus` when the loader supplied
 * one, else an inert port that answers EMPTY_FOCUS and never fires. Widgets
 * call this once in `init` so they never branch on the port's presence.
 */
export function focusPortOf(ctx) {
  const port = ctx && ctx.focus;
  if (port && typeof port.get === 'function' && typeof port.subscribe === 'function') return port;
  return {
    get: () => EMPTY_FOCUS,
    subscribe: () => () => {},
    openSurface: () => {},
    closeSurface: () => {},
    isSurfaceOpen: () => false,
  };
}
