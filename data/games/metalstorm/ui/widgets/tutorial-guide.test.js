// @vitest-environment happy-dom
// tutorial-guide.test.js — the coach card renders one beat from fixture
// `tutorial_*` params, finishes client beats itself, and answers on the wire.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import guide, { tutorialModel, encodeWire, showTarget, SHOW_EVENT } from './tutorial-guide.js';

const RUNNING = {
  tutorial_active: 1, tutorial_state: 'running', tutorial_team: 0,
  tutorial_beat: 2, tutorial_beat_count: 8, tutorial_beat_id: 'select',
  tutorial_title: 'Select a squad', tutorial_text: 'Left-click one of your squads.',
  tutorial_wait: 'client', tutorial_check: 'selection',
  tutorial_show_x: 896, tutorial_show_z: 6272, tutorial_rev: 3,
};

function fakeStore(params, selection = []) {
  const map = new Map(Object.entries(params));
  const subs = [];
  return {
    map,
    getGameRulesParams: () => map,
    getSelection: () => ({ unitIds: selection, cmdDescs: [] }),
    subscribe: (_paths, cb) => { subs.push(cb); return () => {}; },
    fire: () => subs.forEach((cb) => cb()),
    set: (k, v) => { map.set(k, v); subs.forEach((cb) => cb()); },
  };
}

function mount(store, extra = {}) {
  const el = document.createElement('div');
  document.body.append(el);
  const sendCommand = vi.fn();
  guide.init({ mount: el, store, identity: { playerId: 1, teamId: 0 }, sendCommand, ...extra });
  return { el, sendCommand };
}

afterEach(() => { guide.dispose(); document.body.innerHTML = ''; });

describe('encodeWire', () => {
  it('matches parley/wire.lua: cmd first, reserved bytes escaped, lists joined', () => {
    expect(encodeWire('tutorial.ack', { beat: 'a=b&c' })).toBe('cmd=tutorial.ack&beat=a%3Db%26c');
    expect(encodeWire('parley.propose', { kind: 'intel', regionKeys: ['x', 'y'] }))
      .toBe('cmd=parley.propose&kind=intel&regionKeys=x,y');
  });
});

describe('tutorialModel', () => {
  it('is invisible outside a tutorial and after Hide', () => {
    expect(tutorialModel(new Map()).visible).toBe(false);
    expect(tutorialModel(new Map([['tutorial_active', 1], ['tutorial_state', 'stopped']])).visible).toBe(false);
  });

  it('reads the beat, its show point and an offered proposal', () => {
    const m = tutorialModel(fakeStore({ ...RUNNING,
      tutorial_parley_kind: 'intel', tutorial_parley_to: 1, tutorial_parley_regions: 'raven_basin' }).map);
    expect(m.index).toBe(2);
    expect(m.check).toBe('selection');
    expect(m.show).toEqual({ x: 896, z: 6272, panel: null });
    expect(m.parley).toEqual({ kind: 'intel', toTeam: 1, regionKeys: ['raven_basin'] });
  });
});

describe('tutorial-guide widget', () => {
  it('renders the card and acks an ack-beat on Next', () => {
    const store = fakeStore({ ...RUNNING, tutorial_beat_id: 'welcome', tutorial_wait: 'ack', tutorial_check: undefined });
    const { el, sendCommand } = mount(store);
    expect(el.textContent).toContain('Step 2 of 8');
    expect(el.textContent).toContain('Select a squad');
    el.querySelector('[data-act="ack"]').click();
    expect(sendCommand).toHaveBeenCalledWith({ type: 'LuaRulesMsg', data: 'cmd=tutorial.ack&beat=welcome' });
    el.querySelector('[data-act="skip"]').click();
    expect(sendCommand).toHaveBeenLastCalledWith({ type: 'LuaRulesMsg', data: 'cmd=tutorial.skip&beat=welcome' });
  });

  it('finishes a selection beat itself, exactly once, when a selection lands', () => {
    const selection = [];
    const store = fakeStore(RUNNING, selection);
    const { el, sendCommand } = mount(store);
    expect(el.querySelector('[data-act="ack"]')).toBeNull();     // nothing to press
    expect(sendCommand).not.toHaveBeenCalled();
    selection.push(42);
    store.fire();
    store.fire();
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith({ type: 'LuaRulesMsg', data: 'cmd=tutorial.ack&beat=select' });
  });

  it('offers the beat\'s proposal as a button that sends the parley verb', () => {
    const store = fakeStore({ ...RUNNING, tutorial_wait: 'pact', tutorial_check: undefined,
      tutorial_parley_kind: 'intel', tutorial_parley_to: 1, tutorial_parley_regions: 'raven_basin' });
    const { el, sendCommand } = mount(store);
    el.querySelector('[data-act="parley"]').click();
    expect(sendCommand).toHaveBeenCalledWith('parley.propose', { kind: 'intel', toTeam: 1, regionKeys: ['raven_basin'] });
  });

  it('shows the finished card with Restart, and hides after stop', () => {
    const store = fakeStore({ tutorial_active: 1, tutorial_state: 'done' });
    const { el, sendCommand } = mount(store);
    expect(el.textContent).toContain('Training complete');
    el.querySelector('[data-act="restart"]').click();
    expect(sendCommand).toHaveBeenCalledWith({ type: 'LuaRulesMsg', data: 'cmd=tutorial.restart' });
    store.set('tutorial_state', 'stopped');
    expect(el.textContent).toBe('');
  });
});

describe('showTarget', () => {
  it('prefers a camera, then the native-ui global, then an event', () => {
    const travelTo = vi.fn();
    expect(showTarget({ camera: { travelTo } }, { x: 1, z: 2 })).toBe('camera');
    expect(travelTo).toHaveBeenCalledWith(1, 2);

    globalThis.__nativeUi = { travelTo: vi.fn(), open: vi.fn() };
    expect(showTarget({}, { x: 1, z: 2 })).toBe('nativeUi');
    expect(showTarget({}, { panel: 'diplomacy' })).toBe('nativeUi');
    expect(globalThis.__nativeUi.open).toHaveBeenCalledWith('diplomacy');
    delete globalThis.__nativeUi;

    const seen = vi.fn();
    document.addEventListener(SHOW_EVENT, (e) => seen(e.detail));
    expect(showTarget({}, { x: 3, z: 4, panel: null })).toBe('event');
    expect(seen).toHaveBeenCalledWith({ x: 3, z: 4, panel: null });
  });
});
