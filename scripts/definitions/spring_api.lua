---@meta
--- Spring Engine Lua API type stubs for IDE autocompletion.
--- These definitions provide type info for the Lua Language Server
--- (sumneko/LuaLS) without running the engine.

---@class SpringAPI
---@field GetMyTeamID fun(): number
---@field GetMyAllyTeamID fun(): number
---@field GetMyPlayerID fun(): number
---@field GetGameFrame fun(): number
---@field GetGameSpeed fun(): number
---@field GetUnitPosition fun(unitId: number): number, number, number
---@field GetUnitHealth fun(unitId: number): number, number, number
---@field GetUnitDefID fun(unitId: number): number
---@field GetUnitTeam fun(unitId: number): number
---@field GetSelectedUnits fun(): number[]
---@field GetTeamResources fun(teamId: number, type: string): number, number
---@field GetTeamColor fun(teamId: number): number, number, number, number
---@field IsPaused fun(): boolean
---@field Log fun(section: string, level: number, message: string)
Spring = {}

---@class GlAPI
---@field Color fun(r: number, g: number, b: number, a: number)
---@field Rect fun(x1: number, y1: number, x2: number, y2: number)
---@field Text fun(text: string, x: number, y: number, size: number)
---@field PushMatrix fun()
---@field PopMatrix fun()
---@field Translate fun(x: number, y: number, z: number)
---@field Scale fun(x: number, y: number, z: number)
---@field Rotate fun(angle: number, x: number, y: number, z: number)
gl = {}

---@class GLConstants
GL = {}
GL.TRIANGLES = 0x0004
GL.QUADS = 0x0007
GL.LINES = 0x0001
GL.SRC_ALPHA = 0x0302
GL.ONE_MINUS_SRC_ALPHA = 0x0303
