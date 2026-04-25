function widget:GetInfo()
	return {
		name      = "Font Baseline Test",
		desc      = "Draws specific glyphs with reference baseline lines to diagnose alignment issues.",
		author    = "engine",
		date      = "2026-04-26",
		license   = "GPLv2",
		layer     = 0,
		enabled   = true,
		handler   = false,
	}
end

local font

local function gradients()
	-- Red baseline, green ascender, blue x-height, magenta descender
	return {
		base   = {1.0, 0.2, 0.2, 1},
		asc    = {0.2, 1.0, 0.2, 1},
		xh     = {0.4, 0.6, 1.0, 1},
		desc   = {1.0, 0.2, 1.0, 1},
		text   = {1.0, 1.0, 1.0, 1},
	}
end

function widget:Initialize()
	font = gl.LoadFont("FreeSansBold.otf", 48, 0, 1.0)
	-- Force load probe sizes so the font-debug log fires for chili's size range.
	gl.LoadFont("FreeSansBold.otf", 14, 0, 1.0)
	gl.LoadFont("FreeSansBold.otf", 16, 0, 1.0)
end

function widget:DrawScreen()
	if not font then return end
	local g = gradients()
	-- Spring uses Y-up screen coords (y=0 at bottom). font:Print(text, x, y)
	-- with no valign puts the text TOP at y, with the rest extending DOWN
	-- (lower world y / lower on screen). So baseline = y - ascent.
	local _, vsy = gl.GetViewSizes and gl.GetViewSizes() or nil, 753
	local startX = 40
	local topY   = (vsy or 753) - 80   -- highest row near top of screen
	local lineH  = 90
	local size   = 48

	-- Test cases: rows with specific glyph mixes
	local tests = {
		{ text = "HXIO"     },
		{ text = "axoeuns"  },
		{ text = "gpqyj"    },
		{ text = "dbklhf"   },
		{ text = ".,;:'-_"  },
		{ text = "AjgQpqHy" },
	}

	-- Get the global font ascent / descent in pixels.
	-- font.lineheight and font.descender are normalised (multiply by size).
	local lineH_px = font.lineheight * size
	local desc_px  = font.descender  * size  -- negative
	local asc_px   = lineH_px + desc_px

	for i, t in ipairs(tests) do
		local y = topY - (i - 1) * lineH

		-- Y-up: text top at y. Baseline below by asc_px → world y - asc_px.
		local baselineY = y - asc_px
		-- Line bottom (descender) → y - lineH_px
		local lineBottomY = y - lineH_px

		local x1 = startX
		local x2 = startX + 800

		-- Top of line (green) — should hit cap-letter tops (with diacritic gap)
		gl.Color(g.asc[1], g.asc[2], g.asc[3], g.asc[4])
		gl.Rect(x1, y, x2, y + 1)

		-- Baseline (red) — should hit bottom of all non-descender glyphs
		gl.Color(g.base[1], g.base[2], g.base[3], g.base[4])
		gl.Rect(x1, baselineY, x2, baselineY + 1)

		-- Line bottom (magenta) — should hit bottom of descender tails (g, p, j)
		gl.Color(g.desc[1], g.desc[2], g.desc[3], g.desc[4])
		gl.Rect(x1, lineBottomY, x2, lineBottomY + 1)

		-- Render the text at (startX, y) with no flag (top alignment)
		gl.Color(1, 1, 1, 1)
		font:Begin()
		font:Print(t.text, startX, y, size, "")
		font:End()
	end
end
