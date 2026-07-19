// Pure matrix-expansion + config-patching core for the headless batch driver
// (PLAN-headless task 3). No child_process/fs here — kept side-effect-free so
// `test/matrix.test.mjs` can assert the §6 "meta" requirement (2x2x2 -> 8 rows
// with distinct seeds) without touching a real spring-server binary, the same
// split HeadlessRun.{h,cpp}/StatsDump.{h,cpp} use (pure core + engine-coupled
// wiring in server_main.cpp).

// Sets `value` at a dot-path (e.g. "aiSlots.0.profile") inside a plain JSON
// object/array tree, creating intermediate objects/arrays as needed. Numeric
// path segments index into arrays; everything else is an object key.
export function setPath(root, path, value) {
    const segments = path.split('.');
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i];
        const key = /^\d+$/.test(seg) ? Number(seg) : seg;
        const nextSeg = segments[i + 1];
        const nextIsIndex = /^\d+$/.test(nextSeg);
        if (node[key] === undefined || node[key] === null) {
            node[key] = nextIsIndex ? [] : {};
        }
        node = node[key];
    }
    const lastSeg = segments[segments.length - 1];
    const lastKey = /^\d+$/.test(lastSeg) ? Number(lastSeg) : lastSeg;
    node[lastKey] = value;
    return root;
}

// Cartesian product of each axis's `values`, applied as overrides onto a
// deep clone of `template`. `spec.axes` is `[{ path, values }, ...]`.
// Returns one row per combination: `{ index, params, config }` where
// `params` is a flat `{ [axisPath]: value }` object for JSONL/labelling and
// `config` is the patched headless-run manifest ready to write to disk.
//
// Axis order is preserved in the product (first axis varies slowest), so a
// 2x2x2 spec deterministically yields 8 rows in a stable, reproducible order.
export function expandMatrix(spec, template) {
    const axes = spec.axes ?? [];
    if (axes.length === 0)
        return [{ index: 0, params: {}, config: structuredClone(template) }];

    let rows = [{ params: {} }];
    for (const axis of axes) {
        const next = [];
        for (const row of rows) {
            for (const value of axis.values) {
                next.push({ params: { ...row.params, [axis.path]: value } });
            }
        }
        rows = next;
    }

    return rows.map((row, index) => {
        const config = structuredClone(template);
        for (const [path, value] of Object.entries(row.params))
            setPath(config, path, value);
        return { index, params: row.params, config };
    });
}
