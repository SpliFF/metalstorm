import { describe, it, expect } from 'vitest';
import { LuaRuntime } from './lua-runtime.js';
import {
    widgetProfileStart, widgetProfileStop, widgetProfileDump,
    parseWidgetProfileDump, buildUiProfileReport,
    type UiTaxAccumulator,
} from './widget-profiler.js';

/** A runtime with a minimal widgetHandler shaped like cawidgets/barwidgets:
 *  widgets on `widgetHandler.widgets`, callins as plain table fields,
 *  dispatch via dynamic method lookup (w:Update(dt)). */
function makeRuntime(): LuaRuntime {
    const rt = new LuaRuntime('wprof-test');
    const err = rt.doString(`
        widgetHandler = { widgets = {} }
        local function addWidget(name)
            local w = { whInfo = { name = name }, updates = 0, draws = 0 }
            function w:Update(dt) self.updates = self.updates + 1 end
            function w:DrawScreen()
                self.draws = self.draws + 1
                -- burn a little time so the accumulator sees a nonzero value
                local x = 0
                for i = 1, 5000 do x = x + i end
                return x
            end
            widgetHandler.widgets[#widgetHandler.widgets + 1] = w
            return w
        end
        addWidget('Alpha Widget')
        addWidget('Beta Widget')
        function runCallins(n)
            for i = 1, n do
                for _, w in ipairs(widgetHandler.widgets) do
                    w:Update(0.033)
                    w:DrawScreen()
                end
            end
        end
    `, 'setup');
    expect(err).toBeNull();
    return rt;
}

describe('widget-profiler Lua wrap/dump/stop (real Fengari runtime)', () => {
    it('accumulates per-widget per-callin time and counts', () => {
        const rt = makeRuntime();
        expect(widgetProfileStart(rt)).toBeNull();
        expect(rt.doString('runCallins(10)', 'drive')).toBeNull();
        const dump = widgetProfileDump(rt);
        expect(dump).not.toBeNull();
        // 2 widgets × 2 callins with ≥1 call each
        const byKey = new Map(dump!.entries.map(e => [`${e.widget}/${e.callin}`, e]));
        expect(byKey.get('Alpha Widget/Update')?.calls).toBe(10);
        expect(byKey.get('Alpha Widget/DrawScreen')?.calls).toBe(10);
        expect(byKey.get('Beta Widget/Update')?.calls).toBe(10);
        for (const e of dump!.entries) expect(e.ms).toBeGreaterThanOrEqual(0);
        // sorted descending by total ms
        for (let i = 1; i < dump!.entries.length; i++) {
            expect(dump!.entries[i - 1].ms).toBeGreaterThanOrEqual(dump!.entries[i].ms);
        }
    });

    it('wrappers preserve self + arguments and return values', () => {
        const rt = makeRuntime();
        expect(widgetProfileStart(rt)).toBeNull();
        // DrawScreen returns the burn-loop sum through the 4-slot wrapper;
        // Update mutates self via the passed self reference.
        const ok = rt.evalString(`
            local w = widgetHandler.widgets[1]
            local r = w:DrawScreen()
            w:Update(0.5)
            return (r ~= nil and r > 0) and (w.updates == 1) and (w.draws == 1)
        `, 'verify');
        expect(ok).toBe(true);
    });

    it('start is idempotent; stop restores the original functions', () => {
        const rt = makeRuntime();
        expect(rt.doString(`
            origUpdate = widgetHandler.widgets[1].Update
        `, 'snap')).toBeNull();
        expect(widgetProfileStart(rt)).toBeNull();
        // second start must not double-wrap
        expect(widgetProfileStart(rt)).toBeNull();
        expect(rt.evalString(
            'return widgetHandler.widgets[1].Update ~= origUpdate', 'wrapped')).toBe(true);
        expect(widgetProfileStop(rt)).toBeNull();
        expect(rt.evalString(
            'return widgetHandler.widgets[1].Update == origUpdate', 'restored')).toBe(true);
        // dump after stop → not profiling
        expect(widgetProfileDump(rt)).toBeNull();
    });
});

describe('parseWidgetProfileDump', () => {
    it('parses frames, blocks, and sorted entries', () => {
        const raw = [
            '#frames\t120',
            '#block\tdrawScreen\t4800.5',
            '#block\tchunkExec\t9000.0',
            'Chili Framework\tDrawScreen\t4500.250\t120',
            'Tiny Widget\tUpdate\t12.5\t120',
        ].join('\n');
        const d = parseWidgetProfileDump(raw);
        expect(d.frames).toBe(120);
        expect(d.blocks['drawScreen']).toBeCloseTo(4800.5);
        expect(d.entries[0].widget).toBe('Chili Framework');
        expect(d.entries[0].ms).toBeCloseTo(4500.25);
        expect(d.entries[1].calls).toBe(120);
    });
});

describe('buildUiProfileReport', () => {
    const tax: UiTaxAccumulator = {
        frames: 100, save: 150, lua: 8000, restore: 50, wipe: 200, rml: 30,
    };

    it('computes per-frame means and the P5-vs-Fengari split', () => {
        const r = buildUiProfileReport(tax, null);
        expect(r.tax.save).toBeCloseTo(1.5);
        expect(r.tax.lua).toBeCloseTo(80);
        expect(r.tax.total).toBeCloseTo(84.3);
        expect(r.blocks).toBeNull();
        expect(r.widgets).toBeNull();
        expect(r.table).toContain('Fengari runFrame');
    });

    it('merges the Lua dump: block means, attribution, ranked widgets', () => {
        const dump = parseWidgetProfileDump([
            '#frames\t100',
            '#block\tchunkExec\t7500',
            '#block\tdrawScreen\t6000',
            'Chili Framework\tDrawScreen\t5000\t100',
            'HUD Panel\tUpdate\t1000\t100',
        ].join('\n'));
        const r = buildUiProfileReport(tax, dump);
        expect(r.blocks!['chunkExec']).toBeCloseTo(75);
        // compile/dispatch overhead = JS lua mean (80) − chunkExec mean (75)
        expect(r.blocks!['chunkOverhead']).toBeCloseTo(5);
        expect(r.widgets![0].widget).toBe('Chili Framework');
        expect(r.widgets![0].msPerFrame).toBeCloseTo(50);
        expect(r.attribution!.widgetMsPerFrame).toBeCloseTo(60);
        expect(r.attribution!.unattributedMsPerFrame).toBeCloseTo(15);
        expect(r.table).toContain('Chili Framework');
    });
});
