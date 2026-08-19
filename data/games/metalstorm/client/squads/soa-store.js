// soa-store.js — the member-array pool for the SoA squad engine.
// PLAN-metalstorm-squad-performance.md §10b/§10c/§10d. Milestone S3: store +
// run allocator only — no kernel reads these views yet (S4).
//
// One ArrayBuffer, one offset table (`layoutViews`), SAB-ready by
// construction: every view is 64-byte aligned, nothing here closes over a
// view (every function takes the store as its first argument), and growth is
// "new pool + copy + generation++" so a future re-attach (worker/SAB) just
// rebuilds identical views from the same offset table.

// mFlags bits (§10c).
export const MFLAG_ALIVE = 1;
export const MFLAG_RELEASED = 2;
export const MFLAG_COLUMN = 4;

const ALIGN = 64;

// The layout table itself: order fixes the byte offsets, so it is not
// reorderable without also invalidating any serialized layout elsewhere
// (none exists yet — this is the only reader/writer of offsets).
const FIELDS = [
  ['mx', Float32Array], ['my', Float32Array], ['mz', Float32Array],
  ['mvx', Float32Array], ['mvz', Float32Array],
  ['mHeading', Float32Array], ['mGait', Float32Array], ['mBank', Float32Array],
  ['mAltOff', Float32Array],
  ['mFlags', Uint8Array], ['mRecovery', Uint8Array], ['mModeStreak', Uint8Array],
  ['mSlot', Uint16Array], ['mRepackFrom', Int16Array],
  ['mRepackT', Float32Array],
  ['mStuck', Uint16Array],
  ['mLastDist2', Float32Array],
  // Altitude above the squad centroid, snapshotted when an AIR squad drops to
  // the `centroid`/`icon` tier (Member.centroidDy's twin): that tier has no
  // ground sample to rebuild a flyer's cruise height from. Ground/naval unused.
  ['mCentroidDy', Float32Array],
  // `mPool` is the backend HANDLE (createMember's return). The pair below is
  // S5's direct-write binding (§13a): the pool the member's instance sits in and
  // the instance index inside it, both -1 when the member is not pinned (either
  // the backend offers no direct path, or the member's visual tier is re-decided
  // per frame from the camera and its index therefore cannot be held). Refreshed
  // from the backend whenever `poolGeneration` moves — see soa-kernel.js.
  ['mPool', Int32Array], ['mDirectPool', Int32Array], ['mPoolIdx', Int32Array],
];

function alignUp(n, align) { return Math.ceil(n / align) * align; }

/** Compute the offset table for `capacity` members. The one function used by
 *  both allocation and any future re-attach from a transferred buffer. */
export function layoutViews(buffer, capacity) {
  const layout = [];
  let offset = 0;
  for (const [name, Ctor] of FIELDS) {
    const bytes = capacity * Ctor.BYTES_PER_ELEMENT;
    layout.push({ name, offset, bytes, Ctor });
    offset = alignUp(offset + bytes, ALIGN);
  }
  return { layout, byteLength: offset };
}

function buildViews(buffer, capacity) {
  const { layout, byteLength } = layoutViews(buffer, capacity);
  const views = {};
  for (const { name, offset, Ctor } of layout) {
    views[name] = new Ctor(buffer, offset, capacity);
  }
  return { views, byteLength, layout };
}

/** The single ArrayBuffer swap point (§10b): a one-line change to
 *  `new SharedArrayBuffer(...)` is the whole SAB migration for this file. */
export function allocPool(byteLength) {
  return new ArrayBuffer(byteLength);
}

/** Create a store with room for `capacity` members. */
export function createStore(capacity = 4096) {
  capacity = Math.max(1, capacity | 0);
  return growStoreTo(
    {
      buffer: null, capacity: 0, highWater: 0, generation: 0,
      freeLists: new Map(), // exact-size run free-list (§10d) — allocation-time only
    },
    capacity,
  );
}

// Rebuild the store's buffer/views at (at least) `capacity`, copying any live
// data forward and bumping `generation`. Used both by createStore (from an
// empty store) and by growth.
function growStoreTo(store, capacity) {
  const buffer = allocPool(layoutViews(null, capacity).byteLength);
  const { views: newViews } = buildViews(buffer, capacity);
  if (store.buffer) {
    for (const [name] of FIELDS) {
      newViews[name].set(store.views[name].subarray(0, Math.min(store.capacity, capacity)));
    }
  }
  store.buffer = buffer;
  store.views = newViews;
  store.capacity = capacity;
  store.generation = (store.generation | 0) + 1;
  // Flat accessors (store.mx, store.mz, ...) so callers don't thread
  // `store.views.mx` everywhere.
  for (const [name] of FIELDS) store[name] = newViews[name];
  return store;
}

/** Grow the store so it can hold `store.highWater + extra` members. Doubles
 *  capacity until it fits (§10b: growth = new pool + copy + generation++). */
export function growStore(store, extra) {
  let capacity = Math.max(1, store.capacity);
  const need = store.highWater + extra;
  while (capacity < need) capacity *= 2;
  growStoreTo(store, capacity);
}

/** Allocate a contiguous run of `size` member slots for one squad. Reuses an
 *  exact-size freed run if one exists (§10d — no splitting/coalescing: the
 *  size population is a handful of distinct `squad_size` values, small and
 *  stable), else bumps `highWater`, else grows the pool. Returns the base
 *  index; the run occupies `[base, base+size)`. */
export function allocRun(store, size) {
  size = Math.max(1, size | 0);
  const stack = store.freeLists.get(size);
  if (stack && stack.length) return stack.pop();
  if (store.highWater + size > store.capacity) growStore(store, size);
  const base = store.highWater;
  store.highWater += size;
  return base;
}

/** Return a run to its exact-size free-list. Allocation-time only — never
 *  called per frame. */
export function freeRun(store, base, size) {
  size = Math.max(1, size | 0);
  let stack = store.freeLists.get(size);
  if (!stack) store.freeLists.set(size, (stack = []));
  stack.push(base);
}

export function isAlive(store, i) { return (store.mFlags[i] & MFLAG_ALIVE) !== 0; }
export function isReleased(store, i) { return (store.mFlags[i] & MFLAG_RELEASED) !== 0; }
export function setAlive(store, i, on) {
  store.mFlags[i] = on ? (store.mFlags[i] | MFLAG_ALIVE) : (store.mFlags[i] & ~MFLAG_ALIVE);
}
export function setReleased(store, i, on) {
  store.mFlags[i] = on ? (store.mFlags[i] | MFLAG_RELEASED) : (store.mFlags[i] & ~MFLAG_RELEASED);
}
