--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--
--  file:    unitdefs.lua
--  brief:   unitdef parser
--  author:  Dave Rodgers
--
--  Copyright (C) 2007.
--  Licensed under the terms of the GNU GPL, v2 or later.
--
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------

local unitDefs = {}

local shared = {} -- shared amongst the lua unitdef enviroments

local preProcFile  = 'gamedata/unitdefs_pre.lua'
local postProcFile = 'gamedata/unitdefs_post.lua'

local FBI = FBIparser or VFS.Include('gamedata/parse_fbi.lua')
local TDF = TDFparser or VFS.Include('gamedata/parse_tdf.lua')
local DownloadBuilds = VFS.Include('gamedata/download_builds.lua')

local system = VFS.Include('gamedata/system.lua')
VFS.Include('gamedata/VFSUtils.lua')
local section = 'unitdefs.lua'


--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--
--  Run a pre-processing script if one exists
--

if (VFS.FileExists(preProcFile)) then
  Shared   = shared    -- make it global
  UnitDefs = unitDefs  -- make it global
  VFS.Include(preProcFile)
  UnitDefs = nil
  Shared   = nil
end


--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--
--  Load the FBI unitdef files
--

local fbiFiles = RecursiveFileSearch('units/', '*.fbi') 


for _, filename in ipairs(fbiFiles) do
  local ud, err = FBI.Parse(filename)
  if (ud == nil) then
    Spring.Log(section, LOG.ERROR, 'Error parsing ' .. filename .. ': ' .. err)
  elseif (ud.unitname == nil) then
    Spring.Log(section, LOG.ERROR, 'Missing unitName in ' .. filename)
  else
    ud.unitname = string.lower(ud.unitname)
    unitDefs[ud.unitname] = ud
  end
end


--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--
--  Load the raw LUA format unitdef files
--  (these will override the FBI/SWU versions)
--


local luaFiles = RecursiveFileSearch('units/', '*.lua')

-- Skip `_`-prefixed helpers: a leading underscore marks a shared include, not
-- a unitdef. E.g. Metalstorm's units/_builder.lua is a def GENERATOR that real
-- unit files VFS.Include and call — it returns a function, so scanning it as a
-- unitdef logged a spurious "Bad return table" every boot. (Convention only;
-- real unitdef files never start with `_`.)
do
  local filtered = {}
  for _, filename in ipairs(luaFiles) do
    local base = string.match(filename, "([^/\\]+)$") or filename
    if string.sub(base, 1, 1) ~= '_' then
      filtered[#filtered + 1] = filename
    end
  end
  luaFiles = filtered
end

for _, filename in ipairs(luaFiles) do
  local udEnv = {}
  udEnv._G = udEnv
  udEnv.Shared = shared
  udEnv.GetFilename = function() return filename end
  setmetatable(udEnv, { __index = system })
  local success, uds = pcall(VFS.Include, filename, udEnv)
  if (not success) then
    Spring.Log(section, LOG.ERROR, 'Error parsing ' .. filename .. ': ' .. tostring(uds))
  elseif (type(uds) ~= 'table') then
    Spring.Log(section, LOG.ERROR, 'Bad return table from: ' .. filename)
  else
    for udName, ud in pairs(uds) do
      if ((type(udName) == 'string') and (type(ud) == 'table')) then
        unitDefs[udName] = ud
      else
        Spring.Log(section, LOG.ERROR, 'Bad return table entry from: ' .. filename)
      end
    end
  end  
end


--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--
--  Insert the download build entries
--

DownloadBuilds.Execute(unitDefs)


--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--
--  Run a post-processing script if one exists
--

if (VFS.FileExists(postProcFile)) then
  Shared   = shared    -- make it global
  UnitDefs = unitDefs  -- make it global
  VFS.Include(postProcFile)
  UnitDefs = nil
  Shared   = nil
end


--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--
--  Basic checks to kill unitDefs that will crash ".give all"
--

-- spring-web fork: in a headless server build the unit model is
-- only used for rendering (which happens on the client), piece
-- scripts, and projectile hit geometry. None of those are fatal
-- at load time — we can still spawn and simulate a unit with no
-- .s3o file on disk, as long as it has a collision volume defined
-- in its def. Upstream Spring stripped these defs entirely which
-- meant a game shipping placeholder/clientside-only models (Paper
-- Tanks, early prototypes) had zero spawnable units. Now we just
-- warn and keep the def.
for name, def in pairs(unitDefs) do
  local obj = def.objectName or def.objectname
  if (obj == nil) then
    unitDefs[name] = nil
    Spring.Log(section, LOG.ERROR, 'removed ' .. name ..
                ' unitDef, missing objectname param')
  else
    local objfile = 'objects3d/' .. obj
    if ((not VFS.FileExists(objfile))           and
        (not VFS.FileExists(objfile .. '.3do')) and
        (not VFS.FileExists(objfile .. '.s3o'))) then
      Spring.Log(section, LOG.NOTICE, name
                  .. ': no model file under objects3d/ (' .. obj
                  .. '); keeping the def — collision will use the'
                  .. ' def\'s collisionVolume params and rendering'
                  .. ' is the client\'s problem')
    end
  end
end


for name, def in pairs(unitDefs) do
  local badOptions = {}
  local buildOptions = def.buildOptions or def.buildoptions
  if (buildOptions) then
    for i, option in ipairs(buildOptions) do
      if (unitDefs[option] == nil) then
        table.insert(badOptions, i)
        Spring.Log(section, LOG.ERROR, 'removed the "' .. option ..'" entry'
                    .. ' from the "' .. name .. '" build menu')
      end
    end
    if (#badOptions > 0) then
      local removed = 0
      for _, badIndex in ipairs(badOptions) do
        table.remove(buildOptions, badIndex - removed)
        removed = removed + 1
      end
    end
  end
end


--------------------------------------------------------------------------------
--------------------------------------------------------------------------------

return unitDefs

--------------------------------------------------------------------------------
-------------------------------------------------------------------------------- 
