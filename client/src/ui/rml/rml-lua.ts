/**
 * rml-lua.ts — the Lua source for the `RmlUi` proxy machinery (PLAN-rml.md §4).
 *
 * Kept in its own module so rml-bridge.ts (the JS orchestrator) stays small.
 * This string is `runtime.doString`'d once by `installRmlGlobal`. It defines
 * the `RmlUi` global and its Context / Document / Element / DataModel proxies as
 * Lua tables with metatables — metatables (`__index`/`__newindex` for property
 * access like `element.inner_rml` / `context.dp_ratio`) are far cleaner in Lua
 * than via the raw fengari C-API.
 *
 * The Lua↔JS boundary is two primitives:
 *   • `__rmlRecordOp(opTable)`  — JS sink; pushes an op onto the frame queue.
 *   • `RmlUi.__dispatchEvent`   — Lua fn JS calls back into on a DOM event.
 * Handles are a single monotonic integer (globally unique, so they never
 * collide across the main-thread per-kind maps). Reads (inner_rml / GetChild /
 * HasChildNodes / data-model fields) are answered from worker-side mirror
 * fields so they never round-trip (PLAN-rml.md §1.3).
 */

export const RML_LUA = `
local record = __rmlRecordOp

local nextHandle = 0
local function alloc()
  nextHandle = nextHandle + 1
  return nextHandle
end

RmlUi = {}
RmlUi.__listeners = {}       -- key "elemHandle:event" -> Lua fn
local contextsByName = {}    -- name -> context proxy
local contextList = {}       -- ordered array for RmlUi.contexts()

----------------------------------------------------------------------
-- Element proxy
----------------------------------------------------------------------
local elemMethods = {}
local elemMeta = {}

local function newElem(doc, handle, id)
  return setmetatable({
    _h = handle, _doc = doc, _k = 'elem', _id = id,
    _children = {}, _innerRml = '', _className = '',
  }, elemMeta)
end

function elemMethods.SetClass(self, name, on)
  record({ op = 'elSetClass', elem = self._h, name = tostring(name), on = on and true or false })
end

function elemMethods.SetAttribute(self, name, value)
  record({ op = 'elSetAttr', elem = self._h, name = tostring(name), value = tostring(value) })
end

function elemMethods.AppendChild(self, child)
  if type(child) ~= 'table' or not child._h then return end
  self._children[#self._children + 1] = child
  record({ op = 'elAppend', parent = self._h, child = child._h })
end

function elemMethods.RemoveChild(self, child)
  if type(child) ~= 'table' or not child._h then return end
  for i = 1, #self._children do
    if self._children[i] == child then
      table.remove(self._children, i)
      break
    end
  end
  record({ op = 'elRemoveChild', parent = self._h, child = child._h })
end

-- RmlUi GetChild is 0-indexed.
function elemMethods.GetChild(self, i)
  return self._children[(i or 0) + 1]
end

function elemMethods.HasChildNodes(self)
  return #self._children > 0
end

function elemMethods.AddEventListener(self, evt, fn, _capture)
  RmlUi.__listeners[self._h .. ':' .. tostring(evt)] = fn
  record({ op = 'elAddListener', elem = self._h, doc = self._doc, event = tostring(evt) })
end

elemMeta.__index = function(t, k)
  if k == 'inner_rml' then return rawget(t, '_innerRml') end
  if k == 'class_name' then return rawget(t, '_className') end
  if k == 'id' then return rawget(t, '_id') end
  return elemMethods[k]
end

elemMeta.__newindex = function(t, k, v)
  if k == 'inner_rml' then
    rawset(t, '_innerRml', v)
    -- Setting inner_rml replaces the element's content, so its tracked
    -- children are gone (any new ones are added via CreateElement/AppendChild).
    rawset(t, '_children', {})
    record({ op = 'elSetInnerRml', elem = rawget(t, '_h'), rml = tostring(v) })
  elseif k == 'class_name' then
    rawset(t, '_className', v)
    record({ op = 'elSetClassName', elem = rawget(t, '_h'), className = tostring(v) })
  else
    rawset(t, k, v)
  end
end

----------------------------------------------------------------------
-- Document proxy
----------------------------------------------------------------------
local docMethods = {}
local docMeta = { __index = function(t, k) return docMethods[k] end }

local function newDoc(ctx, handle)
  return setmetatable({ _h = handle, _ctx = ctx, _k = 'doc', _elemById = {} }, docMeta)
end

function docMethods.Show(self) record({ op = 'docShow', doc = self._h }) end
function docMethods.Hide(self) record({ op = 'docHide', doc = self._h }) end
function docMethods.Close(self) record({ op = 'docClose', doc = self._h }) end
function docMethods.ReloadStyleSheet(self) record({ op = 'docReloadCss', doc = self._h }) end

-- GetElementById returns a STABLE proxy per (doc, id): RmlUi returns the same
-- underlying element each call, and BAR relies on that — its leaderboard
-- rebuild does GetElementById then a HasChildNodes/GetChild/RemoveChild clear
-- loop across frames, which only works if the child mirror persists.
function docMethods.GetElementById(self, id)
  id = tostring(id)
  local cached = self._elemById[id]
  if cached then return cached end
  local h = alloc()
  local e = newElem(self._h, h, id)
  self._elemById[id] = e
  record({ op = 'elGetById', doc = self._h, elem = h, id = id })
  return e
end

function docMethods.CreateElement(self, tag)
  local h = alloc()
  -- Detached node (not yet in _elemById; only id-addressable elements are).
  local e = newElem(self._h, h, nil)
  record({ op = 'elCreate', doc = self._h, elem = h, tag = tostring(tag) })
  return e
end

----------------------------------------------------------------------
-- Data-model proxy (MVVM): field mutation IS the update (no dirty flag).
----------------------------------------------------------------------
local dmMeta = {}
local function newDataModel(handle, initial)
  -- _v mirrors last-set values so reads (dmHandle.field) never round-trip.
  local mirror = {}
  if type(initial) == 'table' then
    for k, v in pairs(initial) do mirror[k] = v end
  end
  return setmetatable({ _h = handle, _k = 'dm', _v = mirror }, dmMeta)
end

dmMeta.__index = function(t, k)
  return rawget(t, '_v')[k]
end

dmMeta.__newindex = function(t, k, v)
  rawget(t, '_v')[k] = v
  record({ op = 'dmSet', dm = rawget(t, '_h'), key = tostring(k), value = v })
end

----------------------------------------------------------------------
-- Context proxy
----------------------------------------------------------------------
local ctxMethods = {}
local ctxMeta = {}

local function newContext(handle, name)
  return setmetatable({ _h = handle, _k = 'ctx', _name = name, _dpRatio = 1 }, ctxMeta)
end

function ctxMethods.OpenDataModel(self, name, initial, _widget)
  local h = alloc()
  local snapshot = {}
  if type(initial) == 'table' then
    for k, v in pairs(initial) do snapshot[k] = v end
  end
  record({ op = 'dmOpen', ctx = self._h, dm = h, name = tostring(name), initial = snapshot })
  return newDataModel(h, snapshot)
end

function ctxMethods.RemoveDataModel(self, name)
  -- BAR passes the model name; main keys models on their handle, but BAR only
  -- removes a model right before closing its document, so a name-tagged remove
  -- is sufficient. Handle 0 = "resolve by name on main".
  record({ op = 'dmRemove', dm = 0, name = tostring(name) })
end

function ctxMethods.LoadDocument(self, path, _owner)
  local h = alloc()
  record({ op = 'docLoad', ctx = self._h, doc = h, rmlPath = tostring(path) })
  return newDoc(self._h, h)
end

ctxMeta.__index = function(t, k)
  if k == 'dp_ratio' then return rawget(t, '_dpRatio') end
  return ctxMethods[k]
end

ctxMeta.__newindex = function(t, k, v)
  if k == 'dp_ratio' then
    rawset(t, '_dpRatio', v)
    record({ op = 'ctxDpRatio', ctx = rawget(t, '_h'), dpRatio = tonumber(v) or 1 })
  else
    rawset(t, k, v)
  end
end

----------------------------------------------------------------------
-- RmlUi global
----------------------------------------------------------------------
function RmlUi.CreateContext(name)
  name = tostring(name)
  local existing = contextsByName[name]
  if existing then return existing end
  local h = alloc()
  local ctx = newContext(h, name)
  contextsByName[name] = ctx
  contextList[#contextList + 1] = ctx
  record({ op = 'ctxCreate', ctx = h, name = name })
  return ctx
end

function RmlUi.GetContext(name)
  return contextsByName[tostring(name)]
end

function RmlUi.contexts()
  return contextList
end

function RmlUi.LoadFontFace(path, fallback)
  record({ op = 'fontFace', path = tostring(path), fallback = fallback and true or false })
end

function RmlUi.SetMouseCursorAlias(cssName, engineCursor)
  record({ op = 'cursorAlias', cssName = tostring(cssName), engineCursor = tostring(engineCursor) })
end

-- Called by JS (rmlHandleEvent) on a native DOM event. Dispatch to the Lua
-- listener; build the minimal event object BAR reads. StopPropagation is a
-- worker-side flag: propagation is already resolved on main by the time we see
-- the event, so it only needs to exist (and prevent us re-dispatching).
function RmlUi.__dispatchEvent(self, elem, evt, payload)
  local fn = RmlUi.__listeners[elem .. ':' .. tostring(evt)]
  if not fn then return end
  local stopped = false
  local event = {
    parameters = (payload and payload.params) or {},
    mouse_x = payload and payload.mouseX or 0,
    mouse_y = payload and payload.mouseY or 0,
    button = payload and payload.button or 0,
    StopPropagation = function() stopped = true end,
  }
  local ok, err = pcall(fn, event)
  if not ok then
    Spring.Echo('[rml] event listener error: ' .. tostring(err))
  end
end
`;
