-- Minimal headless runner (busted's downloads were network-blocked in this
-- sandbox). Provides describe/it and uses luassert for the assert.* API, so
-- tests/planner_spec.lua runs unmodified. In a normal dev env, use `busted`.
package.path = './?.lua;./tests/?.lua;' .. package.path
_G.assert = require('luassert')

local tests, curr = {}, ''
function _G.describe(name, fn) local p = curr; curr = name; fn(); curr = p end
function _G.it(name, fn) tests[#tests + 1] = { name = curr .. ' :: ' .. name, fn = fn } end

dofile('tests/planner_spec.lua')

local pass, fail = 0, 0
for _, t in ipairs(tests) do
    local ok, err = pcall(t.fn)
    if ok then pass = pass + 1; print('PASS  ' .. t.name)
    else fail = fail + 1; print('FAIL  ' .. t.name); print('        ' .. tostring(err)) end
end
print(string.format('--- %d passed, %d failed ---', pass, fail))
os.exit(fail == 0 and 0 or 1)
