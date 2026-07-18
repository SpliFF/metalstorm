// ui/lib/regions.test.js — client region-index tests.
// Run: cd client && npx vitest run --config ../data/games/metalstorm/ui/vitest.config.js --root ../data/games/metalstorm/ui

import { describe, it, expect } from 'vitest';
import { createRegionIndex } from './regions.js';

function square(x0, z0, x1, z1) {
  return [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
}

describe('grid provider', () => {
  const json = { provider: 'grid', mapWidth: 8192, mapHeight: 8192, regionSize: 2048, gridW: 4, gridH: 4 };

  it('floor-divides into stable keys', () => {
    const idx = createRegionIndex(json);
    expect(idx.at(0, 0)).toBe('0:0');
    expect(idx.at(2049, 0)).toBe('1:0');
    expect(idx.at(0, 2049)).toBe('0:1');
  });

  it('defaults value/tags/neighbors for unauthored grid regions', () => {
    const idx = createRegionIndex(json);
    expect(idx.value('0:0')).toBe(0);
    expect(idx.tags('0:0')).toEqual([]);
    expect(idx.neighbors('0:0')).toEqual([]);
  });
});

describe('graph provider', () => {
  const regions = [
    { key: 'north', polygon: square(0, 0, 1000, 1000), value: 1.5, tags: ['civilian'], neighbors: ['south'] },
    { key: 'south', polygon: square(0, 2000, 1000, 3000), value: 1.0, tags: [], neighbors: ['north'] },
  ];
  const json = { provider: 'graph', mapWidth: 4096, mapHeight: 4096, regions };

  it('resolves points inside authored polygons to their key', () => {
    const idx = createRegionIndex(json);
    expect(idx.at(500, 500)).toBe('north');
    expect(idx.at(500, 2500)).toBe('south');
  });

  it('resolves points in no polygon to the synthetic wilds region', () => {
    const idx = createRegionIndex(json);
    expect(idx.at(500, 1500)).toBe('wilds');
    expect(idx.value('wilds')).toBe(0);
  });

  it('exposes authored metadata', () => {
    const idx = createRegionIndex(json);
    expect(idx.value('north')).toBe(1.5);
    expect(idx.tags('north')).toEqual(['civilian']);
    expect(idx.neighbors('north')).toEqual(['south']);
  });

  it('agrees with the sim on lookup-grid boundary cells (parity, §10)', () => {
    // Same fixture as the Lua partition_spec.lua lookup-grid test.
    const oneRegion = [{ key: 'a', polygon: square(0, 0, 300, 300), neighbors: [] }];
    const idx = createRegionIndex({ provider: 'graph', mapWidth: 1024, mapHeight: 1024, regions: oneRegion });
    expect(idx.at(280, 280)).toBe('a');    // inside, boundary cell
    expect(idx.at(320, 320)).toBe('wilds'); // just outside the polygon, same boundary cell
  });
});

describe('ownership mirror (applyParams)', () => {
  const json = { provider: 'grid', mapWidth: 8192, mapHeight: 8192, regionSize: 2048, gridW: 4, gridH: 4 };

  it('defaults to unowned/neutral before any params applied', () => {
    const idx = createRegionIndex(json);
    expect(idx.owner('0:0')).toBe(-1);
    expect(idx.isContested('0:0')).toBe(false);
  });

  it('ingests region_<key>_team / _contested and reports true on change', () => {
    const idx = createRegionIndex(json);
    const changed = idx.applyParams({ 'region_0:0_team': 3, 'region_0:0_contested': 1, regions_rev: 1 });
    expect(changed).toBe(true);
    expect(idx.owner('0:0')).toBe(3);
    expect(idx.isContested('0:0')).toBe(true);
    expect(idx.regionsRev).toBe(1);
  });

  it('is regions_rev-guarded: a repeat batch with the same rev is a no-op', () => {
    const idx = createRegionIndex(json);
    idx.applyParams({ 'region_0:0_team': 3, regions_rev: 1 });
    const changed = idx.applyParams({ 'region_0:0_team': 99, regions_rev: 1 });
    expect(changed).toBe(false);
    expect(idx.owner('0:0')).toBe(3); // unchanged — stale batch ignored
  });
});

describe('order-cost prediction (costModifierAt, authority §4)', () => {
  const json = { provider: 'grid', mapWidth: 8192, mapHeight: 8192, regionSize: 2048, gridW: 4, gridH: 4 };

  it('is neutral (1.0) for an unowned region', () => {
    const idx = createRegionIndex(json);
    expect(idx.costModifierAt(100, 100, 0)).toBe(1.0);
  });

  it('is friendly (0.5) when the querying team owns the region', () => {
    const idx = createRegionIndex(json);
    idx.applyParams({ 'region_0:0_team': 5, regions_rev: 1 });
    expect(idx.costModifierAt(100, 100, 5)).toBe(0.5);
  });

  it('is enemy (2.0) by default when a different team owns it (no alliance data)', () => {
    const idx = createRegionIndex(json);
    idx.applyParams({ 'region_0:0_team': 5, regions_rev: 1 });
    expect(idx.costModifierAt(100, 100, 6)).toBe(2.0);
  });

  it('respects a supplied isAllied predicate', () => {
    const idx = createRegionIndex(json);
    idx.applyParams({ 'region_0:0_team': 5, regions_rev: 1 });
    const isAllied = (ownerTeam, teamId) => ownerTeam === 5 && teamId === 6;
    expect(idx.costModifierAt(100, 100, 6, isAllied)).toBe(0.5);
  });
});
