function widget:GetInfo()
	return {
		name      = "Render Test",
		desc      = "Per-page tests of gl.* primitives. 1-9 = primitive pages, [/] = prev/next, 0 = cycle.",
		author    = "spring-web",
		date      = "2026-04-25",
		license   = "GPL v2",
		layer     = 1000000,
		enabled   = true,
		handler   = true,
	}
end

------------------------------------------------------------------------
-- Config
------------------------------------------------------------------------

local PAGE_NAMES = {
	"01 Solid rects (gl.Rect + gl.Color)",
	"02 Lines (BeginEnd GL.LINES)",
	"03 Triangles (BeginEnd GL.TRIANGLES)",
	"04 Quads (BeginEnd GL.QUADS)",
	"05 Matrix transforms (Translate/Scale/Rotate)",
	"06 Display lists (CreateList/CallList)",
	"07 Scissor",
	"08 TexRect (no texture = white)",
	"09 Font (gl.LoadFont + font:Print)",
	"10 Texture: load + bind + TexRect",
	"11 Texture: position grid (32px cells)",
	"12 Texture: scale (1x/2x/4x/8x)",
	"13 Texture: UV mapping (full/quad/flipped)",
	"14 Texture: 9-slice (panel)",
	"15 Texture: bind in CreateList + tint",
}

local NUM_PAGES = #PAGE_NAMES
local currentPage = 1

local font = nil
local cachedList = nil
local cachedTexList = nil
local frameCount = 0

-- Texture handles. Loaded lazily on first use of a texture page.
local TEX_QUIT  = "LuaUI/Images/quit.png"   -- 32x32, recognizable X icon
local TEX_TICK  = "LuaUI/Images/tick.png"   -- 32x32, recognizable check icon
local TEX_PANEL = "LuaUI/Widgets/chili/skins/Carbon/panel_0001.png"  -- 64x64

------------------------------------------------------------------------
-- Helpers
------------------------------------------------------------------------

local function setColor(r, g, b, a)
	gl.Color(r, g, b, a or 1)
end

local function drawText(str, x, y, size, flags)
	if not font then return end
	font:Print(str, x, y, size or 14, flags or "")
end

------------------------------------------------------------------------
-- Pages
------------------------------------------------------------------------

local pages = {}

-- Page 1: solid rects
pages[1] = function(vsx, vsy)
	-- Three rects in primary colors
	setColor(1, 0, 0, 1)
	gl.Rect(100, vsy - 200, 200, vsy - 100)

	setColor(0, 1, 0, 1)
	gl.Rect(220, vsy - 200, 320, vsy - 100)

	setColor(0, 0, 1, 1)
	gl.Rect(340, vsy - 200, 440, vsy - 100)

	-- Alpha blend test
	setColor(1, 1, 1, 0.5)
	gl.Rect(150, vsy - 250, 400, vsy - 220)

	-- Reset color so subsequent draws are visible
	setColor(1, 1, 1, 1)
end

-- Page 2: lines
pages[2] = function(vsx, vsy)
	gl.LineWidth(2)

	-- Horizontal line
	setColor(1, 1, 0, 1)
	gl.BeginEnd(GL.LINES, function()
		gl.Vertex(100, vsy - 150)
		gl.Vertex(500, vsy - 150)
	end)

	-- Diagonal lines (X)
	setColor(0, 1, 1, 1)
	gl.BeginEnd(GL.LINES, function()
		gl.Vertex(100, vsy - 250)
		gl.Vertex(500, vsy - 350)
		gl.Vertex(100, vsy - 350)
		gl.Vertex(500, vsy - 250)
	end)

	-- Line strip rectangle outline
	setColor(1, 0, 1, 1)
	gl.BeginEnd(GL.LINE_STRIP, function()
		gl.Vertex(100, vsy - 400)
		gl.Vertex(500, vsy - 400)
		gl.Vertex(500, vsy - 500)
		gl.Vertex(100, vsy - 500)
		gl.Vertex(100, vsy - 400)
	end)

	gl.LineWidth(1)
	setColor(1, 1, 1, 1)
end

-- Page 3: triangles
pages[3] = function(vsx, vsy)
	-- Solid red triangle (CCW)
	setColor(1, 0.3, 0.3, 1)
	gl.BeginEnd(GL.TRIANGLES, function()
		gl.Vertex(150, vsy - 250)
		gl.Vertex(250, vsy - 250)
		gl.Vertex(200, vsy - 150)
	end)

	-- Solid green triangle (CW — should still render since culling off)
	setColor(0.3, 1, 0.3, 1)
	gl.BeginEnd(GL.TRIANGLES, function()
		gl.Vertex(300, vsy - 150)
		gl.Vertex(400, vsy - 250)
		gl.Vertex(350, vsy - 250)
	end)

	-- Per-vertex color triangle
	gl.BeginEnd(GL.TRIANGLES, function()
		gl.Color(1, 0, 0, 1); gl.Vertex(450, vsy - 250)
		gl.Color(0, 1, 0, 1); gl.Vertex(550, vsy - 250)
		gl.Color(0, 0, 1, 1); gl.Vertex(500, vsy - 150)
	end)

	setColor(1, 1, 1, 1)
end

-- Page 4: quads
pages[4] = function(vsx, vsy)
	setColor(1, 0.7, 0.2, 1)
	gl.BeginEnd(GL.QUADS, function()
		gl.Vertex(100, vsy - 200)
		gl.Vertex(200, vsy - 200)
		gl.Vertex(200, vsy - 100)
		gl.Vertex(100, vsy - 100)
	end)

	-- Per-vertex color quad
	gl.BeginEnd(GL.QUADS, function()
		gl.Color(1, 0, 0, 1); gl.Vertex(220, vsy - 200)
		gl.Color(0, 1, 0, 1); gl.Vertex(320, vsy - 200)
		gl.Color(0, 0, 1, 1); gl.Vertex(320, vsy - 100)
		gl.Color(1, 1, 0, 1); gl.Vertex(220, vsy - 100)
	end)

	setColor(1, 1, 1, 1)
end

-- Page 5: matrix transforms
pages[5] = function(vsx, vsy)
	-- Translated rect
	gl.PushMatrix()
		gl.Translate(150, vsy - 200, 0)
		setColor(1, 0.4, 0.4, 1)
		gl.Rect(0, 0, 80, 80)
	gl.PopMatrix()

	-- Scaled rect
	gl.PushMatrix()
		gl.Translate(280, vsy - 200, 0)
		gl.Scale(2, 1, 1)
		setColor(0.4, 1, 0.4, 1)
		gl.Rect(0, 0, 40, 80)
	gl.PopMatrix()

	-- Rotated rect (around center)
	gl.PushMatrix()
		gl.Translate(500, vsy - 160, 0)
		gl.Rotate(45, 0, 0, 1)
		setColor(0.4, 0.4, 1, 1)
		gl.Rect(-40, -40, 40, 40)
	gl.PopMatrix()

	-- Combined T+R+S
	gl.PushMatrix()
		gl.Translate(650, vsy - 160, 0)
		gl.Rotate((frameCount * 2) % 360, 0, 0, 1)
		gl.Scale(1.5, 1.5, 1)
		setColor(1, 1, 0.4, 1)
		gl.Rect(-30, -30, 30, 30)
	gl.PopMatrix()

	setColor(1, 1, 1, 1)
end

-- Page 6: display lists + line/rect interaction
-- A: line strip ALONE (no preceding rect)
-- B: line strip AFTER rect (suspected breakage)
-- C: same as B but inside a CreateList
pages[6] = function(vsx, vsy)
	gl.LineWidth(4)

	-- A: line strip alone (live)
	gl.PushMatrix()
		gl.Translate(120, vsy - 250, 0)
		setColor(1, 1, 0, 1)
		gl.BeginEnd(GL.LINE_STRIP, function()
			gl.Vertex(0, 0)
			gl.Vertex(100, 0)
			gl.Vertex(100, 100)
			gl.Vertex(0, 100)
			gl.Vertex(0, 0)
		end)
	gl.PopMatrix()

	-- B: rect + line strip OFFSET 10px outside the rect
	gl.PushMatrix()
		gl.Translate(250, vsy - 250, 0)
		setColor(1, 0.5, 1, 1)
		gl.Rect(0, 0, 100, 100)
		setColor(1, 1, 0, 1)
		gl.BeginEnd(GL.LINE_STRIP, function()
			gl.Vertex(-10, -10)
			gl.Vertex(110, -10)
			gl.Vertex(110, 110)
			gl.Vertex(-10, 110)
			gl.Vertex(-10, -10)
		end)
	gl.PopMatrix()

	-- C: rect + line strip recorded into list (offset 10px outside rect)
	if not cachedList then
		cachedList = gl.CreateList(function()
			setColor(1, 0.5, 1, 1)
			gl.Rect(0, 0, 100, 100)
			setColor(1, 1, 0, 1)
			gl.BeginEnd(GL.LINE_STRIP, function()
				gl.Vertex(-10, -10)
				gl.Vertex(110, -10)
				gl.Vertex(110, 110)
				gl.Vertex(-10, 110)
				gl.Vertex(-10, -10)
			end)
		end)
	end
	gl.PushMatrix()
		gl.Translate(380, vsy - 250, 0)
		gl.CallList(cachedList)
	gl.PopMatrix()

	-- D: line strip BEFORE rect (live) — does the rect break or work?
	gl.PushMatrix()
		gl.Translate(510, vsy - 250, 0)
		setColor(1, 1, 0, 1)
		gl.BeginEnd(GL.LINE_STRIP, function()
			gl.Vertex(0, 0)
			gl.Vertex(100, 0)
			gl.Vertex(100, 100)
			gl.Vertex(0, 100)
			gl.Vertex(0, 0)
		end)
		setColor(1, 0.5, 1, 0.5)
		gl.Rect(20, 20, 80, 80)
	gl.PopMatrix()

	gl.LineWidth(1)

	if font then
		font:Begin()
			setColor(1, 1, 1, 1)
			font:Print("A: line only", 170, vsy - 280, 12, "c")
			font:Print("B: rect+line", 300, vsy - 280, 12, "c")
			font:Print("C: list",      430, vsy - 280, 12, "c")
			font:Print("D: line+rect", 560, vsy - 280, 12, "c")
		font:End()
	end

	setColor(1, 1, 1, 1)
end

-- Page 7: scissor test
pages[7] = function(vsx, vsy)
	-- Big background rect that should be partially clipped
	setColor(0.3, 0.3, 0.3, 1)
	gl.Rect(100, vsy - 400, 600, vsy - 100)

	-- Enable scissor for a centered region
	gl.Scissor(200, vsy - 350, 300, 200)

	setColor(1, 0.5, 0, 1)
	gl.Rect(50, vsy - 500, 700, vsy - 50)

	gl.Scissor(false)

	setColor(1, 1, 1, 1)
end

-- Page 8: TexRect with no bound texture
pages[8] = function(vsx, vsy)
	-- TexRect without a texture should render solid white (or whatever color)
	setColor(0.4, 0.8, 1, 1)
	gl.TexRect(150, vsy - 250, 350, vsy - 150)

	-- Two with explicit UVs
	setColor(1, 1, 1, 1)
	gl.TexRect(380, vsy - 250, 580, vsy - 150, 0, 0, 1, 1)
end

-- Page 9: font
pages[9] = function(vsx, vsy)
	if not font then
		setColor(1, 0.3, 0.3, 1)
		gl.Rect(100, vsy - 250, 600, vsy - 230)
		return
	end

	font:Begin()
		setColor(1, 1, 1, 1)
		font:Print("The quick brown fox", 100, vsy - 200, 18, "")

		setColor(1, 1, 0, 1)
		font:Print("Centered (16px)", vsx / 2, vsy - 240, 16, "c")

		setColor(0, 1, 1, 1)
		font:Print("Right-aligned (14px)", vsx - 100, vsy - 280, 14, "r")

		-- Outlined
		setColor(1, 0.4, 0.4, 1)
		font:Print("Outlined", 100, vsy - 320, 22, "o")
	font:End()

	setColor(1, 1, 1, 1)
end

------------------------------------------------------------------------
-- Texture pages (10-15)
--
-- Notes:
--   * Spring's gl.TexRect uses Y-up screen coords like the rest of our
--     ortho. To match the on-disk pixel orientation, the V coord is
--     swapped (t1=1, t2=0). gl.TexRect(x1,y1,x2,y2) without UVs uses
--     this convention internally — but with explicit UVs the caller
--     must pass t1>t2 to avoid an upside-down texture.
--   * Textures load asynchronously. First few frames after switching
--     pages will show the magenta 1x1 placeholder. The Page indicator
--     "Loading..." shows when TextureInfo width<=1.
------------------------------------------------------------------------

local function texInfo(path)
	if not gl.TextureInfo then return nil end
	local ok, info = pcall(gl.TextureInfo, path)
	if not ok or type(info) ~= "table" then return nil end
	return info
end

local function texLoaded(path)
	local info = texInfo(path)
	return info and info.xsize and info.xsize > 1
end

local function loadingLabel(path, x, y)
	if not font then return end
	if not texLoaded(path) then
		setColor(1, 0.5, 0.5, 1)
		font:Begin()
			font:Print("(loading " .. path .. ")", x, y, 11, "")
		font:End()
		setColor(1, 1, 1, 1)
	end
end

-- Page 10: load + bind + TexRect basic
pages[10] = function(vsx, vsy)
	loadingLabel(TEX_QUIT, 100, vsy - 60)

	-- Bind quit.png and draw at original 32x32 size
	gl.Texture(TEX_QUIT)
		setColor(1, 1, 1, 1)
		gl.TexRect(100, vsy - 132, 132, vsy - 100)

		-- Same texture, double size
		gl.TexRect(160, vsy - 164, 224, vsy - 100)

		-- Quad size with explicit UVs (full image)
		gl.TexRect(250, vsy - 228, 378, vsy - 100, 0, 1, 1, 0)
	gl.Texture(false)

	-- After unbind, plain rect should show solid color (no texture)
	setColor(0.3, 0.6, 0.3, 1)
	gl.Rect(420, vsy - 132, 452, vsy - 100)

	if font then
		font:Begin()
			setColor(1, 1, 1, 1)
			font:Print("32x32",  116, vsy - 152, 11, "c")
			font:Print("64x64",  192, vsy - 184, 11, "c")
			font:Print("128x128",314, vsy - 248, 11, "c")
			font:Print("plain rect", 436, vsy - 152, 11, "c")
		font:End()
	end
	setColor(1, 1, 1, 1)
end

-- Page 11: position grid — 32x32 cells side-by-side, no overlap or gap
pages[11] = function(vsx, vsy)
	loadingLabel(TEX_QUIT, 100, vsy - 60)
	gl.Texture(TEX_QUIT)
		setColor(1, 1, 1, 1)
		-- 6 columns × 3 rows of 32px tiles starting at (100, vsy-200)
		for col = 0, 5 do
			for row = 0, 2 do
				local x = 100 + col * 32
				local y = vsy - 100 - row * 32
				gl.TexRect(x, y - 32, x + 32, y, 0, 1, 1, 0)
			end
		end
	gl.Texture(false)

	-- Reference grid — yellow lines AT the same boundaries.
	-- If positioning is correct, lines lie exactly on tile edges.
	setColor(1, 1, 0, 0.7)
	for col = 0, 6 do
		local x = 100 + col * 32
		gl.BeginEnd(GL.LINES, function()
			gl.Vertex(x, vsy - 100)
			gl.Vertex(x, vsy - 100 - 96)
		end)
	end
	for row = 0, 3 do
		local y = vsy - 100 - row * 32
		gl.BeginEnd(GL.LINES, function()
			gl.Vertex(100, y)
			gl.Vertex(100 + 192, y)
		end)
	end

	if font then
		font:Begin()
			setColor(0.9, 0.9, 0.9, 1)
			font:Print("6x3 grid of 32x32 quit.png — yellow lines should sit on tile edges",
				100, vsy - 215, 12, "")
			font:Print("First tile origin (100, " .. (vsy - 132) .. ")",
				100, vsy - 235, 11, "")
		font:End()
	end
	setColor(1, 1, 1, 1)
end

-- Page 12: scale — 1x, 2x, 4x, 8x baselines aligned at same Y
pages[12] = function(vsx, vsy)
	loadingLabel(TEX_QUIT, 100, vsy - 60)

	-- All tiles share the same TOP edge (y = vsy - 100)
	-- Increasing size grows DOWNWARD.
	local topY  = vsy - 100
	local x = 100
	local sizes = {32, 64, 128, 256}

	-- Backing rects (dark gray) so the TexRect bounds are visible.
	-- The quit.png glyph has transparent padding, so without a backing
	-- rect the visible X would appear to float below the rect's top edge.
	setColor(0.2, 0.2, 0.2, 1)
	local bx = x
	for _, s in ipairs(sizes) do
		gl.Rect(bx, topY - s, bx + s, topY)
		bx = bx + s + 8
	end

	gl.Texture(TEX_QUIT)
		setColor(1, 1, 1, 1)
		for _, s in ipairs(sizes) do
			gl.TexRect(x, topY - s, x + s, topY, 0, 1, 1, 0)
			x = x + s + 8
		end
	gl.Texture(false)

	-- Reference horizontal line at topY — every tile's top edge should
	-- touch this line. Drawn as a 1-px-tall filled rect rather than
	-- GL_LINES, because WebGL2 clamps lineWidth to 1 and rasterises
	-- horizontal lines on the row *above* the integer Y, leaving a
	-- one-pixel gap above the rects.
	setColor(1, 1, 0, 1)
	gl.Rect(80, topY - 1, x + 20, topY)

	if font then
		font:Begin()
			setColor(0.9, 0.9, 0.9, 1)
			font:Print("1x / 2x / 4x / 8x — top of each gray rect sits on the yellow line",
				100, topY + 12, 12, "")
		font:End()
	end
	setColor(1, 1, 1, 1)
end

-- Page 13: UV mapping — full / quadrants / flipped / repeat
pages[13] = function(vsx, vsy)
	loadingLabel(TEX_TICK, 100, vsy - 60)

	local cellSize = 96
	local y = vsy - 100 - cellSize
	local x = 100
	local labels = {}

	gl.Texture(TEX_TICK)
		setColor(1, 1, 1, 1)
		-- Full
		gl.TexRect(x, y, x + cellSize, y + cellSize, 0, 1, 1, 0)
		labels[#labels+1] = {"full", x + cellSize/2}
		x = x + cellSize + 12

		-- Top-left quadrant of texture (zoom)
		gl.TexRect(x, y, x + cellSize, y + cellSize, 0, 0.5, 0.5, 0)
		labels[#labels+1] = {"TL quad", x + cellSize/2}
		x = x + cellSize + 12

		-- Bottom-right quadrant of texture (zoom)
		gl.TexRect(x, y, x + cellSize, y + cellSize, 0.5, 1, 1, 0.5)
		labels[#labels+1] = {"BR quad", x + cellSize/2}
		x = x + cellSize + 12

		-- Horizontal flip
		gl.TexRect(x, y, x + cellSize, y + cellSize, 1, 1, 0, 0)
		labels[#labels+1] = {"flip H", x + cellSize/2}
		x = x + cellSize + 12

		-- Vertical flip (right-side-up texture: pass t1=0, t2=1)
		gl.TexRect(x, y, x + cellSize, y + cellSize, 0, 0, 1, 1)
		labels[#labels+1] = {"flip V", x + cellSize/2}
	gl.Texture(false)

	if font then
		font:Begin()
			setColor(0.9, 0.9, 0.9, 1)
			for _, l in ipairs(labels) do
				font:Print(l[1], l[2], y - 16, 11, "c")
			end
		font:End()
	end
	setColor(1, 1, 1, 1)
end

-- Page 14: 9-slice — corners at native size, edges and center stretched
pages[14] = function(vsx, vsy)
	loadingLabel(TEX_PANEL, 100, vsy - 60)

	local function nineSlice(x1, y1, x2, y2, border)
		-- Source UV math (matches Chili's approach)
		local b = border
		local info = texInfo(TEX_PANEL)
		local tw = (info and info.xsize) or 64
		local th = (info and info.ysize) or 64
		local ub = b / tw
		local vb = b / th

		gl.Texture(TEX_PANEL)
			setColor(1, 1, 1, 1)
			-- Corners (no stretch)
			gl.TexRect(x1,         y2 - b,    x1 + b,    y2,        0, 1, ub, 1 - vb)        -- TL
			gl.TexRect(x2 - b,     y2 - b,    x2,        y2,        1 - ub, 1, 1, 1 - vb)    -- TR
			gl.TexRect(x1,         y1,        x1 + b,    y1 + b,    0, vb, ub, 0)            -- BL
			gl.TexRect(x2 - b,     y1,        x2,        y1 + b,    1 - ub, vb, 1, 0)        -- BR
			-- Edges (stretched along one axis)
			gl.TexRect(x1 + b,     y2 - b,    x2 - b,    y2,        ub, 1, 1 - ub, 1 - vb)   -- top
			gl.TexRect(x1 + b,     y1,        x2 - b,    y1 + b,    ub, vb, 1 - ub, 0)       -- bottom
			gl.TexRect(x1,         y1 + b,    x1 + b,    y2 - b,    0, 1 - vb, ub, vb)       -- left
			gl.TexRect(x2 - b,     y1 + b,    x2,        y2 - b,    1 - ub, 1 - vb, 1, vb)   -- right
			-- Center (stretched both axes)
			gl.TexRect(x1 + b,     y1 + b,    x2 - b,    y2 - b,    ub, 1 - vb, 1 - ub, vb)
		gl.Texture(false)
	end

	-- Three panels at different sizes — stress-test 9-slice scaling
	nineSlice(100, vsy - 200, 240, vsy - 100, 16)
	nineSlice(260, vsy - 280, 460, vsy - 100, 16)
	nineSlice(480, vsy - 380, 760, vsy - 100, 16)

	if font then
		font:Begin()
			setColor(0.9, 0.9, 0.9, 1)
			font:Print("9-slice (border=16): corners should NOT stretch, edges/center should",
				100, vsy - 60, 12, "")
			font:Print("140x100",  170, vsy - 220, 11, "c")
			font:Print("200x180",  360, vsy - 300, 11, "c")
			font:Print("280x280",  620, vsy - 400, 11, "c")
		font:End()
	end
	setColor(1, 1, 1, 1)
end

-- Page 15: texture binding inside CreateList + color tinting.
-- Uses quit.png (white X on transparent) so each tint cleanly multiplies
-- through every channel. Each cell shows TEXTURED (left) and a PLAIN RECT
-- (right) of the same color — they should match where the texture is opaque.
-- Top group is replayed via CallList, bottom group is drawn live.
pages[15] = function(vsx, vsy)
	loadingLabel(TEX_QUIT, 100, vsy - 60)

	if not cachedTexList then
		cachedTexList = gl.CreateList(function()
			gl.Texture(TEX_QUIT)
				gl.TexRect(0, 0, 64, 64, 0, 1, 1, 0)
			gl.Texture(false)
		end)
	end

	-- Tints chosen to exercise each channel independently
	local tints = {
		{1.0, 1.0, 1.0, 1.0, "white"},
		{1.0, 0.2, 0.2, 1.0, "red"},
		{0.2, 1.0, 0.2, 1.0, "green"},
		{0.2, 0.2, 1.0, 1.0, "blue"},
		{1.0, 1.0, 0.2, 1.0, "yellow"},
		{1.0, 1.0, 1.0, 0.4, "alpha 0.4"},
	}

	-- Black backdrop strip behind each row so transparency shows on a
	-- known background (terrain colour would corrupt the visual).
	setColor(0, 0, 0, 1)
	gl.Rect(80, vsy - 280, 80 + #tints * 150 + 20, vsy - 100)
	gl.Rect(80, vsy - 480, 80 + #tints * 150 + 20, vsy - 300)

	local cellW, gap = 64, 8
	-- Row helper draws a single tint cell:  textured (left) | plain (right)
	local function drawCell(x, y, t, useList)
		setColor(t[1], t[2], t[3], t[4])
		if useList then
			gl.PushMatrix()
				gl.Translate(x, y, 0)
				gl.CallList(cachedTexList)
			gl.PopMatrix()
		else
			gl.Texture(TEX_QUIT)
				gl.TexRect(x, y, x + cellW, y + cellW, 0, 1, 1, 0)
			gl.Texture(false)
		end
		-- plain reference rect to the right of the textured cell
		setColor(t[1], t[2], t[3], t[4])
		gl.Rect(x + cellW + gap, y, x + cellW + gap + cellW, y + cellW)
	end

	-- Top row: CallList
	for i, t in ipairs(tints) do
		drawCell(100 + (i-1) * 150, vsy - 180, t, true)
	end

	-- Bottom row: live
	for i, t in ipairs(tints) do
		drawCell(100 + (i-1) * 150, vsy - 380, t, false)
	end

	if font then
		font:Begin()
			setColor(0.9, 0.9, 0.9, 1)
			font:Print("Top row: CallList   |   Bottom row: live   |   left=textured, right=plain (should match where opaque)",
				100, vsy - 80, 11, "")
			for i, t in ipairs(tints) do
				local cx = 100 + (i-1) * 150 + cellW + gap/2
				font:Print(t[5], cx, vsy - 195, 10, "c")
				font:Print(t[5], cx, vsy - 395, 10, "c")
			end
		font:End()
	end
	setColor(1, 1, 1, 1)
end

------------------------------------------------------------------------
-- Header
------------------------------------------------------------------------

local function drawHeader(vsx, vsy)
	-- Solid header bar at top of screen
	setColor(0, 0, 0, 0.7)
	gl.Rect(0, vsy - 40, vsx, vsy)

	-- Indicator strip below header. Width scales so total spans the bar
	-- regardless of page count.
	local stripMax = vsx - 20
	local stripW = (currentPage / NUM_PAGES) * stripMax
	setColor(0, 0, 0, 0.5)
	gl.Rect(10, vsy - 50, 10 + stripMax, vsy - 45)
	setColor(0, 1, 0, 1)
	gl.Rect(10, vsy - 50, 10 + stripW, vsy - 45)

	if font then
		font:Begin()
			setColor(1, 1, 1, 1)
			font:Print(
				PAGE_NAMES[currentPage] or "?",
				12, vsy - 28, 18, ""
			)
			setColor(0.7, 0.7, 0.7, 1)
			font:Print(
				string.format("page %d/%d  |  1-9 jump  [/]= prev/next  0=cycle",
					currentPage, NUM_PAGES),
				vsx - 12, vsy - 28, 14, "r"
			)
		font:End()
	end

	setColor(1, 1, 1, 1)
end

------------------------------------------------------------------------
-- Callins
------------------------------------------------------------------------

function widget:Initialize()
	Spring.Echo("[RenderTest] Initialize")
	if gl.LoadFont then
		local ok, f = pcall(gl.LoadFont, "FreeSansBold.otf", 18, 2, 5)
		if ok and f then
			font = f
			Spring.Echo("[RenderTest] Loaded font")
		else
			Spring.Echo("[RenderTest] gl.LoadFont failed: " .. tostring(f))
		end
	else
		Spring.Echo("[RenderTest] gl.LoadFont not available")
	end
end

function widget:Shutdown()
	if cachedList and gl.DeleteList then
		gl.DeleteList(cachedList)
		cachedList = nil
	end
	if cachedTexList and gl.DeleteList then
		gl.DeleteList(cachedTexList)
		cachedTexList = nil
	end
	if font and gl.DeleteFont then
		gl.DeleteFont(font)
		font = nil
	end
end

function widget:KeyPress(key, mods, isRepeat)
	if isRepeat then return false end
	-- 1..9 jump to those pages directly. 0 / ] cycle forward, [ cycles back.
	-- Pages 10..15 are reachable via 0, ], or [ from pages 1..9.
	if key >= 49 and key <= 57 then  -- '1'..'9'
		local page = key - 48
		if page <= NUM_PAGES then
			currentPage = page
			Spring.Echo("[RenderTest] Page " .. page .. ": " .. PAGE_NAMES[page])
			return true
		end
	elseif key == 48 or key == 93 then  -- '0' or ']'
		currentPage = (currentPage % NUM_PAGES) + 1
		Spring.Echo("[RenderTest] Page " .. currentPage .. ": " .. PAGE_NAMES[currentPage])
		return true
	elseif key == 91 then  -- '['
		currentPage = ((currentPage - 2) % NUM_PAGES) + 1
		Spring.Echo("[RenderTest] Page " .. currentPage .. ": " .. PAGE_NAMES[currentPage])
		return true
	end
	return false
end

function widget:DrawScreen()
	frameCount = frameCount + 1
	local vsx, vsy = Spring.GetViewSizes()
	if not vsx or not vsy or vsx < 1 or vsy < 1 then return end

	-- Draw the page first (may set its own colors)
	local fn = pages[currentPage]
	if fn then
		local ok, err = pcall(fn, vsx, vsy)
		if not ok then
			Spring.Echo("[RenderTest] Page " .. currentPage .. " error: " .. tostring(err))
		end
	end

	-- Header drawn last so it sits on top
	drawHeader(vsx, vsy)
end
