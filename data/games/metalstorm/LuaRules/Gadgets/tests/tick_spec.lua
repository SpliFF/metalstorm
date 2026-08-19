-- tests/tick_spec.lua — the frame-skip-safe periodic gate (D15).
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets && busted tests/

package.path = './?.lua;' .. package.path

local Tick = require('tick')

--- The defect, expressed as a test oracle: how many times a gate fires over a
--- frame sequence. `frames` is the sequence gadget:GameFrame actually receives
--- — a skip is simply a gap in it, because the engine does not deliver the
--- missing frames late (that is the whole premise of D15).
local function firings(frames, period, fn)
    local t, n = Tick.new(period), 0
    for _, f in ipairs(frames) do
        if fn(t, f) then n = n + 1 end
    end
    return n
end

local function contiguous(from, to)
    local out = {}
    for f = from, to do out[#out + 1] = f end
    return out
end

describe("Tick.due — behaviour preservation on an unloaded machine", function()
    it("fires on exactly the frames the old modulo gate did", function()
        local t, fired, expected = Tick.new(90), {}, {}
        for f = 1, 1000 do
            if Tick.due(t, f) then fired[#fired + 1] = f end
            if f % 90 == 0 then expected[#expected + 1] = f end
        end
        assert.are.same(expected, fired)
    end)

    it("does not fire before its first full period", function()
        local t = Tick.new(150)
        for f = 0, 149 do assert.is_false(Tick.due(t, f)) end
        assert.is_true(Tick.due(t, 150))
    end)

    it("fires once per period, not once per frame", function()
        assert.are.equal(11, firings(contiguous(0, 1000), 90, Tick.due))
    end)
end)

describe("Tick.due — the D15 failure mode", function()
    -- Fire 31's probe: gated on `frame % 150 == 0`, it stopped emitting at
    -- f=1500 (the frame the skipping began) and produced 11 samples over a
    -- 24 378-frame war. Model that as a sim that, after f=1500, delivers one
    -- frame in every 50 at an offset of 1 — 457 further GameFrame calls, not
    -- one of which is a multiple of 150. Note the shape of the defect: it is
    -- not that the gate fires less often, it is that it stops entirely while
    -- the gadget keeps being called hundreds of times.
    local function skippingSim()
        local frames = contiguous(1, 1500)
        local f = 1501
        while f <= 24378 do
            frames[#frames + 1] = f
            f = f + 50
        end
        return frames
    end

    it("a modulo gate goes silent for the rest of the war", function()
        local n = 0
        for _, f in ipairs(skippingSim()) do
            if f % 150 == 0 then n = n + 1 end
        end
        assert.are.equal(10, n)     -- 150..1500 and then nothing: the defect
    end)

    it("the skip-safe gate keeps sampling at the right cadence", function()
        local n = firings(skippingSim(), 150, Tick.due)
        -- 24 378 / 150 = 162 whole periods; the last one lands inside the run.
        assert.is_true(n >= 160, "expected ~162 firings, got " .. n)
        assert.is_true(n <= 162, "expected ~162 firings, got " .. n)
    end)

    it("collapses a multi-period skip to a single fire", function()
        local t = Tick.new(90)
        assert.is_true(Tick.due(t, 90))
        assert.is_true(Tick.due(t, 3600))       -- 39 periods elapsed, one fire
        assert.is_false(Tick.due(t, 3601))      -- and the next is not due yet
    end)

    it("keeps the phase grid after a skip instead of drifting", function()
        local t = Tick.new(90)
        assert.is_true(Tick.due(t, 90))
        assert.is_true(Tick.due(t, 500))        -- banks 4 periods -> last = 450
        assert.is_false(Tick.due(t, 539))
        assert.is_true(Tick.due(t, 540))        -- still on multiples of 90
    end)
end)

describe("Tick.count — accrual policy", function()
    it("pays out one period at a time when nothing is skipped", function()
        local t = Tick.new(1800)
        assert.are.equal(0, Tick.count(t, 1799))
        assert.are.equal(1, Tick.count(t, 1800))
        assert.are.equal(0, Tick.count(t, 1801))
        assert.are.equal(1, Tick.count(t, 3600))
    end)

    it("does not let a skip cost a team its income", function()
        -- A stipend of 25/minute over 10 minutes must be 250 whether or not the
        -- machine delivered the exact multiples of 1800.
        local t, paid = Tick.new(1800), 0
        for f = 1, 18000, 700 do    -- 700 is coprime with 1800: no multiple hit
            paid = paid + 25 * Tick.count(t, f)
        end
        paid = paid + 25 * Tick.count(t, 18000)
        assert.are.equal(250, paid)
    end)

    it("reports every elapsed period across one huge gap", function()
        local t = Tick.new(900)
        assert.are.equal(0, Tick.count(t, 100))
        assert.are.equal(27, Tick.count(t, 24378))
        assert.are.equal(900 * 27, t.last)
    end)
end)

describe("Tick — period handling", function()
    it("takes its period from the call when the state has none", function()
        local t = Tick.new()
        assert.is_false(Tick.due(t, 100))       -- no period: never due
        assert.is_true(Tick.due(t, 100, 50))
    end)

    it("treats a zero or negative period as disabled, not as every frame", function()
        local t = Tick.new(0)
        for f = 1, 100 do assert.is_false(Tick.due(t, f)) end
        assert.are.equal(0, Tick.count(Tick.new(-5), 1000))
    end)

    it("adopts a period changed at runtime", function()
        local t = Tick.new(1800)
        assert.is_true(Tick.due(t, 1800))
        assert.is_true(Tick.due(t, 2700, 900))  -- config lowered mid-game
        assert.are.equal(900, t.period)
    end)

    it("survives a frame rewind without banking a negative count", function()
        local t = Tick.new(90)
        assert.is_true(Tick.due(t, 900))
        assert.are.equal(0, Tick.count(t, 10))  -- reload/reset: re-seat, no fire
        assert.is_true(Tick.due(t, 100))
    end)
end)
