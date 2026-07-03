/**
 * PLAN-perf N1 — per-widget Fengari cost profiler.
 *
 * Attributes the LuaUI pass's Fengari slice to individual widgets by wrapping
 * each widget's callin functions (`w[callin]`) with a timing closure. Both
 * the ZK (cawidgets.lua) and BAR (barwidgets.lua) handlers dispatch callins
 * via dynamic method lookup — `w:Update(dt)` / `w:DrawScreen()` — so
 * replacing the function on the widget table times exactly what the handler
 * runs. This is the same hook site BAR's own tracy zones and
 * gui_widget_profiler.lua use, so the approach is faithful to upstream
 * profiling practice.
 *
 * The clock is a JS `performance.now` bridge (`_SpringWebPerfNow`); each
 * timed invocation costs two Lua->JS crossings (~1-2 us) — negligible
 * against the ms-scale costs being measured, but not free, so the profiler
 * is OFF by default and installed only for a measurement session
 * (`window.test.uiProfileStart()` / `uiProfileDump()` / `uiProfileStop()`).
 *
 * While `__wprof` is set, the runFrame chunk (lua-ui-host.ts) additionally
 * accumulates per-block times (update / gameFrame / lightFlatten /
 * drawGenesis / chiliFix / drawWorld / drawScreen / chunkExec) into
 * `__wprof.blocks`, and game-processor.ts accumulates the JS-side fixed-tax
 * slices of gpRunUiPass (GL state save / Fengari / restore / wipeCaches /
 * rmlFlush). `buildUiProfileReport` merges all three into the N1
 * deliverable: the P5-vs-Fengari split plus a ranked widget cost table.
 */

import { LuaRuntime } from './lua-runtime.js';

/** Frame-driven + input callins worth timing. Lifecycle callins
 *  (Initialize/Shutdown/GetConfigData) are one-shot and excluded. */
const HOT_CALLINS = [
    'Update', 'GameFrame', 'GameProgress',
    'DrawGenesis', 'DrawScreen', 'DrawScreenEffects',
    'DrawWorld', 'DrawWorldPreUnit', 'DrawWorldShadow', 'DrawInMiniMap',
    'IsAbove', 'GetTooltip', 'WorldTooltip',
    'MousePress', 'MouseMove', 'MouseRelease', 'MouseWheel',
    'KeyPress', 'KeyRelease', 'TextInput', 'ViewResize',
] as const;

/** Install the timing wrappers on every loaded widget. Idempotent (no-op if
 *  already profiling). Returns null on success or a Lua error string. */
export function widgetProfileStart(rt: LuaRuntime): string | null {
    // The clock bridge. setGlobal is safe to call repeatedly.
    rt.setGlobal('_SpringWebPerfNow', () => performance.now());
    const callins = HOT_CALLINS.map(c => `'${c}'`).join(',');
    return rt.doString(`
        if not __wprof then
            local wh = widgetHandler
            if not wh or not wh.widgets then
                error('widget profiler: no widgetHandler.widgets')
            end
            local callins = { ${callins} }
            local now = _SpringWebPerfNow
            local prof = { acc = {}, cnt = {}, orig = {}, blocks = {}, frames = 0 }
            local widgets = wh.widgets
            for i = 1, #widgets do
                local w = widgets[i]
                local name = (w.whInfo and w.whInfo.name) or ('widget#' .. tostring(i))
                for j = 1, #callins do
                    local cname = callins[j]
                    -- rawget: only wrap callins the widget defines itself,
                    -- not anything inherited from the handler environment.
                    local fn = rawget(w, cname)
                    if type(fn) == 'function' then
                        local key = name .. '\\t' .. cname
                        prof.acc[key] = 0
                        prof.cnt[key] = 0
                        prof.orig[#prof.orig + 1] = { w = w, cname = cname, fn = fn }
                        -- 4 return slots cover every hot callin (most return
                        -- 0-1 values); avoids a table alloc per invocation.
                        w[cname] = function(...)
                            local t0 = now()
                            local r1, r2, r3, r4 = fn(...)
                            local t1 = now()
                            prof.acc[key] = prof.acc[key] + (t1 - t0)
                            prof.cnt[key] = prof.cnt[key] + 1
                            return r1, r2, r3, r4
                        end
                    end
                end
            end
            __wprof = prof
        end
    `, 'wprof_start');
}

/** Restore every wrapped callin to its original function and clear the
 *  accumulators. Returns null on success or a Lua error string. */
export function widgetProfileStop(rt: LuaRuntime): string | null {
    return rt.doString(`
        if __wprof then
            for i = 1, #__wprof.orig do
                local o = __wprof.orig[i]
                o.w[o.cname] = o.fn
            end
            __wprof = nil
        end
    `, 'wprof_stop');
}

export interface WidgetProfileEntry {
    widget: string;
    callin: string;
    /** Total ms accumulated since uiProfileStart. */
    ms: number;
    calls: number;
}

export interface WidgetProfileDump {
    /** runFrame chunk executions observed while profiling. */
    frames: number;
    /** Per-block total ms inside the runFrame chunk (update, gameFrame,
     *  lightFlatten, drawGenesis, chiliFix, drawWorld, drawScreen,
     *  chunkExec = whole-chunk wall time). */
    blocks: Record<string, number>;
    /** Per widget x callin totals, sorted descending by ms. */
    entries: WidgetProfileEntry[];
}

/** Read the accumulators (leaves them running). Null if not profiling. */
export function widgetProfileDump(rt: LuaRuntime): WidgetProfileDump | null {
    const raw = rt.evalString(`
        local p = __wprof
        if not p then return nil end
        local out = {}
        out[#out + 1] = '#frames\\t' .. tostring(p.frames)
        for k, ms in pairs(p.blocks) do
            out[#out + 1] = '#block\\t' .. k .. '\\t' .. string.format('%.3f', ms)
        end
        for key, ms in pairs(p.acc) do
            out[#out + 1] = key .. '\\t' .. string.format('%.3f', ms)
                .. '\\t' .. tostring(p.cnt[key])
        end
        return table.concat(out, '\\n')
    `, 'wprof_dump');
    if (typeof raw !== 'string' || raw.length === 0) return null;
    return parseWidgetProfileDump(raw);
}

/** Parse the tab-separated dump the Lua side emits. Exported for tests. */
export function parseWidgetProfileDump(raw: string): WidgetProfileDump {
    const dump: WidgetProfileDump = { frames: 0, blocks: {}, entries: [] };
    for (const line of raw.split('\n')) {
        const f = line.split('\t');
        if (f[0] === '#frames') {
            dump.frames = Number(f[1]) || 0;
        } else if (f[0] === '#block') {
            dump.blocks[f[1]] = Number(f[2]) || 0;
        } else if (f.length >= 4) {
            dump.entries.push({
                widget: f[0], callin: f[1],
                ms: Number(f[2]) || 0, calls: Number(f[3]) || 0,
            });
        }
    }
    dump.entries.sort((a, b) => b.ms - a.ms);
    return dump;
}

/** JS-side fixed-tax accumulator shape (owned by game-processor.ts, summed
 *  per gpRunUiPass invocation). All values are total ms since reset. */
export interface UiTaxAccumulator {
    frames: number;
    /** The 12 gl.getParameter round-trips + FBO rebind + camera-matrix feed. */
    save: number;
    /** The Fengari runFrame call (compile + execute the frame chunk). */
    lua: number;
    /** GL state restore calls. */
    restore: number;
    /** engine.wipeCaches(true). */
    wipe: number;
    /** rmlFlush batched DOM-op ship. */
    rml: number;
}

export interface UiProfileReport {
    /** Per-frame means of the gpRunUiPass slices (ms). */
    tax: { frames: number; save: number; lua: number; restore: number; wipe: number; rml: number; total: number };
    /** Per-frame means of the runFrame-internal blocks (ms); chunkOverhead =
     *  lua slice minus in-chunk wall time (compile + doString dispatch). */
    blocks: Record<string, number> | null;
    /** Ranked per-widget cost, ms per frame. */
    widgets: Array<{ widget: string; callin: string; msPerFrame: number; ms: number; calls: number }> | null;
    /** Widget-attributed share of the chunk vs the rest. */
    attribution: { widgetMsPerFrame: number; chunkExecMsPerFrame: number; unattributedMsPerFrame: number } | null;
    /** Pre-formatted human-readable table (log this). */
    table: string;
}

/** Merge the JS fixed-tax slices with the Lua-side dump into the N1 report. */
export function buildUiProfileReport(
    tax: UiTaxAccumulator,
    dump: WidgetProfileDump | null,
    topN = 40,
): UiProfileReport {
    const tf = Math.max(1, tax.frames);
    const t = {
        frames: tax.frames,
        save: tax.save / tf,
        lua: tax.lua / tf,
        restore: tax.restore / tf,
        wipe: tax.wipe / tf,
        rml: tax.rml / tf,
        total: (tax.save + tax.lua + tax.restore + tax.wipe + tax.rml) / tf,
    };
    let blocks: Record<string, number> | null = null;
    let widgets: UiProfileReport['widgets'] = null;
    let attribution: UiProfileReport['attribution'] = null;
    const lines: string[] = [];
    lines.push(`LuaUI pass split — ${tax.frames} JS frames`
        + (dump ? `, ${dump.frames} profiled Lua frames` : ' (Lua profiler not running)'));
    lines.push(`  gpRunUiPass total   ${t.total.toFixed(2)} ms/frame`);
    lines.push(`    GL-state save     ${t.save.toFixed(2)}  (P5: getParameter round-trips)`);
    lines.push(`    Fengari runFrame  ${t.lua.toFixed(2)}  (N-track)`);
    lines.push(`    GL-state restore  ${t.restore.toFixed(2)}`);
    lines.push(`    wipeCaches(true)  ${t.wipe.toFixed(2)}  (P5)`);
    lines.push(`    rmlFlush          ${t.rml.toFixed(2)}`);
    if (dump && dump.frames > 0) {
        const df = dump.frames;
        blocks = {};
        for (const [k, v] of Object.entries(dump.blocks)) blocks[k] = v / df;
        const chunkExec = blocks['chunkExec'] ?? 0;
        // Compile/dispatch overhead: JS-measured runFrame minus in-chunk time.
        // (Valid when JS frames ~= Lua frames, i.e. reset happened together.)
        blocks['chunkOverhead'] = Math.max(0, t.lua - chunkExec);
        const blockOrder = ['chunkExec', 'chunkOverhead', 'update', 'gameFrame',
            'lightFlatten', 'drawGenesis', 'chiliFix', 'drawWorld', 'drawScreen'];
        lines.push('  runFrame blocks (ms/frame):');
        for (const k of blockOrder) {
            if (blocks[k] !== undefined) lines.push(`    ${k.padEnd(14)} ${blocks[k].toFixed(2)}`);
        }
        for (const [k, v] of Object.entries(blocks)) {
            if (!blockOrder.includes(k)) lines.push(`    ${k.padEnd(14)} ${v.toFixed(2)}`);
        }
        let widgetTotal = 0;
        widgets = dump.entries.map(e => {
            widgetTotal += e.ms;
            return { widget: e.widget, callin: e.callin, msPerFrame: e.ms / df, ms: e.ms, calls: e.calls };
        });
        attribution = {
            widgetMsPerFrame: widgetTotal / df,
            chunkExecMsPerFrame: chunkExec,
            unattributedMsPerFrame: Math.max(0, chunkExec - widgetTotal / df),
        };
        lines.push(`  widget-attributed ${attribution.widgetMsPerFrame.toFixed(2)} ms/frame; `
            + `handler/other ${attribution.unattributedMsPerFrame.toFixed(2)} ms/frame`);
        lines.push(`  top widget callins (ms/frame over ${df} frames):`);
        for (const w of widgets.slice(0, topN)) {
            if (w.msPerFrame < 0.005) break;
            lines.push(`    ${w.msPerFrame.toFixed(3).padStart(8)}  ${w.widget}  [${w.callin}]  (${w.calls} calls)`);
        }
    }
    return { tax: t, blocks, widgets, attribution, table: lines.join('\n') };
}
