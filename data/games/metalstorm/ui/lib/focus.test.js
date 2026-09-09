// ui/lib/focus.test.js — the read contract over the session focus.
import { describe, it, expect } from 'vitest';
import {
  EMPTY_FOCUS, FOCUS_KINDS, describeFocus, focusPortOf, isFocusBrief, isFocusView,
  isSurfaceOpen, placeOf, primaryOf,
} from './focus.js';

const tanks = { kind: 'squad', label: '3rd Tanks' };
const flight = { kind: 'squad', label: 'Raven Flight' };
const hold = { kind: 'objective', label: 'Hold Raven Basin', place: 'Raven Basin' };

function view(over = {}) {
  return { ...EMPTY_FOCUS, subjects: [], openSurfaces: [], ...over };
}

describe('the shape', () => {
  it('EMPTY_FOCUS is a valid, frozen view', () => {
    expect(isFocusView(EMPTY_FOCUS)).toBe(true);
    expect(Object.isFrozen(EMPTY_FOCUS)).toBe(true);
  });

  it('accepts every declared kind and refuses an unknown one', () => {
    for (const kind of FOCUS_KINDS) expect(isFocusBrief({ kind, label: 'x' })).toBe(true);
    expect(isFocusBrief({ kind: 'spreadsheet', label: 'x' })).toBe(false);
    expect(isFocusBrief({ kind: 'squad' })).toBe(false);
  });

  it('refuses a view that smuggles a non-brief primary', () => {
    expect(isFocusView(view({ primary: { id: 7 } }))).toBe(false);
    expect(isFocusView(view({ primary: tanks }))).toBe(true);
    expect(isFocusView(view({ hovered: undefined }))).toBe(true);
  });
});

describe('primaryOf — the pronoun antecedent', () => {
  it('drilled beats everything', () => {
    expect(primaryOf(view({ drilled: hold, hovered: tanks, primary: flight, subjects: [flight] })))
      .toBe(hold);
  });

  it('hover is opt-in and sits below drilled, above the single subject', () => {
    const v = view({ hovered: tanks, primary: flight, subjects: [flight] });
    expect(primaryOf(v)).toBe(flight);
    expect(primaryOf(v, { preferHover: true })).toBe(tanks);
    expect(primaryOf(view({ drilled: hold, hovered: tanks }), { preferHover: true })).toBe(hold);
  });

  it('two subjects and no drill is null — a real answer, not a guess', () => {
    expect(primaryOf(view({ subjects: [tanks, flight] }))).toBeNull();
    expect(primaryOf(null)).toBeNull();
  });

  it('falls back to the single subject when the model left primary unset', () => {
    expect(primaryOf(view({ subjects: [tanks] }))).toBe(tanks);
  });
});

describe('placeOf', () => {
  it('reads the explicit place, or the label of a place-kind', () => {
    expect(placeOf(view({ drilled: hold }))).toBe('Raven Basin');
    expect(placeOf(view({ subjects: [{ kind: 'area', label: 'Amber Row' }] }))).toBe('Amber Row');
    expect(placeOf(view({ subjects: [tanks] }))).toBeNull();
    expect(placeOf(EMPTY_FOCUS)).toBeNull();
  });
});

describe('describeFocus', () => {
  it('reads like the model\'s own describe()', () => {
    expect(describeFocus(EMPTY_FOCUS)).toBe('nothing selected');
    expect(describeFocus(view({ subjects: [tanks] }))).toBe('3rd Tanks');
    expect(describeFocus(view({ subjects: [tanks, flight] }))).toBe('3rd Tanks, Raven Flight');
    expect(describeFocus(view({ drilled: hold, subjects: [tanks] }))).toBe('Hold Raven Basin (open)');
  });
});

describe('focusPortOf', () => {
  it('returns the loader port when present', () => {
    const port = { get: () => EMPTY_FOCUS, subscribe: () => () => {} };
    expect(focusPortOf({ focus: port })).toBe(port);
  });

  it('returns an inert port otherwise, so widgets never branch', () => {
    const port = focusPortOf({});
    expect(port.get()).toBe(EMPTY_FOCUS);
    expect(typeof port.subscribe(() => {})).toBe('function');
    expect(port.isSurfaceOpen('x')).toBe(false);
    expect(() => port.openSurface('x')).not.toThrow();
  });

  it('isSurfaceOpen reads openSurfaces', () => {
    expect(isSurfaceOpen(view({ openSurfaces: ['battle-menu'] }), 'battle-menu')).toBe(true);
    expect(isSurfaceOpen(EMPTY_FOCUS, 'battle-menu')).toBe(false);
  });
});
