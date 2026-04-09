-- Paper Tanks custom defs.lua
-- Bypasses Spring's VFS.Include-based loading which requires Lua 5.1's setfenv.
-- Loads unit and weapon definitions directly using VFS.LoadFile + load().

local unitDefs = {}
local weaponDefs = {}
local featureDefs = {}
local armorDefs = {}
local moveDefs = {}

-- Helper: load and execute a Lua file, return its result table
local function LoadDefFile(filename)
    local code = VFS.LoadFile(filename)
    if not code then
        Spring.Echo("  Cannot load: " .. filename)
        return nil
    end
    local chunk, err = load(code, filename)
    if not chunk then
        Spring.Echo("  Parse error in " .. filename .. ": " .. tostring(err))
        return nil
    end
    local ok, result = pcall(chunk)
    if not ok then
        Spring.Echo("  Runtime error in " .. filename .. ": " .. tostring(result))
        return nil
    end
    return result
end

-- Load unit files
local unitFiles = VFS.DirList("units/", "*.lua")
Spring.Echo("[defs.lua] Found " .. #unitFiles .. " unit files")
for _, filename in ipairs(unitFiles) do
    local result = LoadDefFile(filename)
    if type(result) == "table" then
        for name, def in pairs(result) do
            if type(name) == "string" and type(def) == "table" then
                unitDefs[name] = def
                Spring.Echo("  Unit: " .. name)
            end
        end
    end
end

-- Load weapon files
local weaponFiles = VFS.DirList("weapons/", "*.lua")
Spring.Echo("[defs.lua] Found " .. #weaponFiles .. " weapon files")
for _, filename in ipairs(weaponFiles) do
    local result = LoadDefFile(filename)
    if type(result) == "table" then
        for name, def in pairs(result) do
            if type(name) == "string" and type(def) == "table" then
                weaponDefs[name] = def
                Spring.Echo("  Weapon: " .. name)
            end
        end
    end
end

-- Move definitions (inline, bypasses TDF parser)
-- Names must be lowercase to match Spring's internal lowerkeys processing
moveDefs = {
    {
        name = "tank2",
        footprintx = 2,
        footprintz = 2,
        maxwaterdepth = 22,
        maxslope = 36,
        crushstrength = 50,
        speedmodclass = 0,
    },
    {
        name = "tank3",
        footprintx = 3,
        footprintz = 3,
        maxwaterdepth = 22,
        maxslope = 30,
        crushstrength = 100,
        speedmodclass = 0,
    },
}

Spring.Echo("[defs.lua] Loaded " .. (function()
    local n = 0; for _ in pairs(unitDefs) do n = n + 1 end; return n
end)() .. " units, " .. (function()
    local n = 0; for _ in pairs(weaponDefs) do n = n + 1 end; return n
end)() .. " weapons")

return {
    UnitDefs = unitDefs,
    WeaponDefs = weaponDefs,
    FeatureDefs = featureDefs,
    ArmorDefs = armorDefs,
    MoveDefs = moveDefs,
}
