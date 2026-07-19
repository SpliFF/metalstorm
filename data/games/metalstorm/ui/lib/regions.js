// ui/lib/regions.js — client mirror of the region graph.
//
// Pure logic, no DOM — shared by the strategic-map overlay
// (shaders/region-overlay.frag.glsl tint texture), order cost prediction
// (ui/lib/authority-cost.js regionMod input), the command composer's named
// places, and the parley pact map layer. See PLAN-metalstorm-regions.md §5.
//
// Data flow: static geometry from the map export (data/maps/<id>/regions.json,
// engine ask R1) + live ownership/contested state from rulesParams
// (region_<key>_team / region_<key>_contested, batched under regions_rev).
//
// Builds the SAME lookup grid the sim uses internally (§1.2) so client-side
// order-cost prediction and the server's actual charge agree on which
// region a point falls in — the only intentional divergence window is the
// live owner/contested state itself (region can flip mid-flight, authority
// §4/§6), never the partition geometry.

const DEFAULT_LOOKUP_CELL = 256;

function pointInPolygon(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, zi = polygon[i].z;
    const xj = polygon[j].x, zj = polygon[j].z;
    if (((zi > z) !== (zj > z)) &&
        (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/** Cell (cellSize elmos) → list of region keys whose bbox overlaps it. */
function buildLookupGrid(regions, mapWidth, mapHeight, cellSize = DEFAULT_LOOKUP_CELL) {
  const gridW = Math.max(1, Math.ceil(mapWidth / cellSize));
  const gridH = Math.max(1, Math.ceil(mapHeight / cellSize));
  const cells = new Map();

  for (const r of regions) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const pt of r.polygon) {
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.z < minZ) minZ = pt.z;
      if (pt.z > maxZ) maxZ = pt.z;
    }
    const cx0 = Math.max(0, Math.floor(minX / cellSize));
    const cx1 = Math.min(gridW - 1, Math.floor(maxX / cellSize));
    const cz0 = Math.max(0, Math.floor(minZ / cellSize));
    const cz1 = Math.min(gridH - 1, Math.floor(maxZ / cellSize));
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = `${cx}:${cz}`;
        let list = cells.get(key);
        if (!list) { list = []; cells.set(key, list); }
        list.push(r.key);
      }
    }
  }

  return { cellSize, gridW, gridH, cells };
}

/**
 * Build the client region index.
 * @param {object} geometryJson parsed regions.json (§8 R1 export): either
 *   `{ provider: 'grid', mapWidth, mapHeight, regionSize, gridW, gridH }` or
 *   `{ provider: 'graph', mapWidth, mapHeight, regions: [{key,name,polygon,
 *     value,tags,neighbors}, ...] }`.
 */
export function createRegionIndex(geometryJson) {
  const provider = geometryJson?.provider === 'graph' ? 'graph' : 'grid';
  const mapWidth = geometryJson?.mapWidth ?? 0;
  const mapHeight = geometryJson?.mapHeight ?? 0;

  let regionSize = 0, gridW = 0, gridH = 0;
  const byKey = new Map();
  let lookupGrid = null;

  if (provider === 'grid') {
    regionSize = geometryJson.regionSize ?? 2048;
    gridW = geometryJson.gridW ?? Math.max(2, Math.ceil(mapWidth / regionSize));
    gridH = geometryJson.gridH ?? Math.max(2, Math.ceil(mapHeight / regionSize));
  } else {
    for (const r of geometryJson.regions ?? []) byKey.set(r.key, r);
    lookupGrid = buildLookupGrid(geometryJson.regions ?? [], mapWidth, mapHeight);
  }

  // Live ownership mirror, fed by applyParams() below.
  const owners = new Map();       // key -> teamId (-1 = neutral/none)
  const contestedFlags = new Map(); // key -> boolean
  let regionsRev = -1;

  function gridKeyAt(x, z) {
    let ix = Math.floor(x / regionSize);
    let iz = Math.floor(z / regionSize);
    if (ix < 0) ix = 0; else if (ix >= gridW) ix = gridW - 1;
    if (iz < 0) iz = 0; else if (iz >= gridH) iz = gridH - 1;
    return `${ix}:${iz}`;
  }

  function graphKeyAt(x, z) {
    const cx = Math.floor(x / lookupGrid.cellSize);
    const cz = Math.floor(z / lookupGrid.cellSize);
    const cellRegions = lookupGrid.cells.get(`${cx}:${cz}`);
    if (!cellRegions) return 'wilds';
    // Always confirm via point-in-polygon, even for a single candidate: a
    // cell's bounding-box overlap list is a filter, not a verdict — an
    // isolated polygon's edge can still cut through a cell with no other
    // region nearby.
    for (const key of cellRegions) {
      const r = byKey.get(key);
      if (r && pointInPolygon(x, z, r.polygon)) return key;
    }
    return 'wilds';
  }

  const index = {
    kind: provider,

    /** Region at world position → key. Grid always resolves; graph gaps resolve to 'wilds'. */
    at(x, z) {
      return provider === 'grid' ? gridKeyAt(x, z) : graphKeyAt(x, z);
    },

    /** Live owner team for a region key (from the rulesParams mirror), or -1. */
    owner(key) {
      return owners.has(key) ? owners.get(key) : -1;
    },

    /** Live contested flag for a region key (orthogonal to owner, §3). */
    isContested(key) {
      return contestedFlags.get(key) ?? false;
    },

    /** Every region key the provider knows (grid cells, or authored keys + 'wilds'). */
    keys() {
      if (provider === 'grid') {
        const out = [];
        for (let ix = 0; ix < gridW; ix++) {
          for (let iz = 0; iz < gridH; iz++) out.push(`${ix}:${iz}`);
        }
        return out;
      }
      return ['wilds', ...byKey.keys()];
    },

    value(key) {
      return byKey.get(key)?.value ?? 0;
    },

    tags(key) {
      return byKey.get(key)?.tags ?? [];
    },

    neighbors(key) {
      return byKey.get(key)?.neighbors ?? [];
    },

    /**
     * Cost modifier at a position, for order-cost prediction (authority §4).
     * `isAllied(ownerTeam, teamId)` lets the caller supply real alliance
     * data; without it, only exact team match counts as friendly (a
     * conservative estimate — never predicts a cheaper order than the sim
     * will actually charge for a non-owning team).
     */
    costModifierAt(x, z, teamId, isAllied) {
      const key = index.at(x, z);
      const ownerTeam = index.owner(key);
      if (ownerTeam === -1) return 1.0;
      const allied = isAllied ? isAllied(ownerTeam, teamId) : ownerTeam === teamId;
      return allied ? 0.5 : 2.0;
    },

    get regionsRev() {
      return regionsRev;
    },

    /**
     * Ingest a rulesParams batch: `region_<key>_team`, `region_<key>_contested`,
     * `regions_rev`. regions_rev-guarded (§5) — a batch whose rev is not newer
     * than the last-applied one (rev <= regionsRev) is a no-op, so the overlay
     * only rebuilds on change and a stale/reordered batch can never move the rev
     * backwards. Returns true if anything actually changed.
     */
    applyParams(params) {
      if (!params) return false;
      const rev = params.regions_rev;
      if (rev !== undefined && rev <= regionsRev) return false;

      let changed = false;
      for (const k of Object.keys(params)) {
        let m = /^region_(.+)_team$/.exec(k);
        if (m) {
          owners.set(m[1], params[k]);
          changed = true;
          continue;
        }
        m = /^region_(.+)_contested$/.exec(k);
        if (m) {
          contestedFlags.set(m[1], !!params[k]);
          changed = true;
        }
      }
      if (rev !== undefined) regionsRev = rev;
      return changed;
    },
  };

  return index;
}

/** Fetch regions.json for a map and build a region index (§5). */
export async function loadRegionIndex(mapDataUrl) {
  const res = await fetch(`${mapDataUrl}/regions.json`);
  if (!res.ok) throw new Error(`regions.json: ${res.status}`);
  const json = await res.json();
  return createRegionIndex(json);
}
