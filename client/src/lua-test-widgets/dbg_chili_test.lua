function widget:GetInfo()
	return {
		name      = "Chili Test",
		desc      = "Minimal Chili widget — single Window with a label, button, and panel. Engine-bundled smoke test for the Chili rendering pipeline.",
		author    = "engine",
		date      = "2026-04-25",
		license   = "GPLv2",
		layer     = 1,
		enabled   = true,
		handler   = false,
	}
end

local Chili
local Window, Label, Button, Panel, TextBox, Image
local screen0
local mainWindow

local frameCount = 0
local lastDrawLog = 0

local function SetupWindow()
	if not WG or not WG.Chili then
		Spring.Echo("[ChiliTest] WG.Chili not available — Chili Framework not loaded?")
		return false
	end

	Chili   = WG.Chili
	Window  = Chili.Window
	Label   = Chili.Label
	Button  = Chili.Button
	Panel   = Chili.Panel
	TextBox = Chili.TextBox
	Image   = Chili.Image
	screen0 = Chili.Screen0

	if not screen0 then
		Spring.Echo("[ChiliTest] Chili.Screen0 missing — cannot build window")
		return false
	end

	mainWindow = Window:New{
		parent     = screen0,
		name       = "chiliTestWindow",
		x          = 60,
		y          = 60,
		width      = 320,
		height     = 240,
		caption    = "Chili Test",
		draggable  = true,
		resizable  = true,
		padding    = {6, 6, 6, 6},
	}

	-- Plain text label
	Label:New{
		parent  = mainWindow,
		x       = 8,
		y       = 8,
		width   = 280,
		height  = 20,
		caption = "Hello from Chili",
		font    = {size = 14, color = {1, 1, 1, 1}},
	}

	-- Coloured TextBox to verify font + colour wiring
	TextBox:New{
		parent  = mainWindow,
		x       = 8,
		y       = 36,
		width   = 280,
		height  = 40,
		text    = "Multi-line text in a TextBox.\nSecond line, same control.",
		font    = {size = 12, color = {0.7, 1.0, 0.7, 1}},
	}

	-- Coloured panel (no texture) — verifies background fills + child layout
	local innerPanel = Panel:New{
		parent          = mainWindow,
		x               = 8,
		y               = 86,
		width           = 280,
		height          = 60,
		backgroundColor = {0.2, 0.3, 0.5, 1},
		padding         = {4, 4, 4, 4},
	}

	Label:New{
		parent  = innerPanel,
		x       = 4,
		y       = 4,
		caption = "Panel child",
		font    = {size = 12, color = {1, 1, 0, 1}},
	}

	-- Button — verifies skin rendering + interactive controls
	Button:New{
		parent  = mainWindow,
		x       = 8,
		bottom  = 8,
		width   = 120,
		height  = 28,
		caption = "Click me",
		OnClick = { function()
			Spring.Echo("[ChiliTest] Button clicked at frame " .. frameCount)
		end },
	}

	Spring.Echo("[ChiliTest] window created: " .. tostring(mainWindow))
	return true
end

function widget:Initialize()
	-- Chili Framework loads in the same pass; defer window creation one
	-- frame so WG.Chili is populated before we touch it.
	widget.deferredSetup = true
end

function widget:Update()
	if widget.deferredSetup then
		widget.deferredSetup = false
		local ok, err = pcall(SetupWindow)
		if not ok then
			Spring.Echo("[ChiliTest] SetupWindow error: " .. tostring(err))
		end
	end
end

function widget:DrawScreen()
	frameCount = frameCount + 1
	-- Log once a second so we can confirm the callin is firing.
	if frameCount - lastDrawLog >= 60 then
		lastDrawLog = frameCount
		Spring.Echo("[ChiliTest] DrawScreen frame=" .. frameCount
			.. " window=" .. tostring(mainWindow)
			.. " visible=" .. tostring(mainWindow and mainWindow.visible))
	end
end

function widget:Shutdown()
	if mainWindow then
		mainWindow:Dispose()
		mainWindow = nil
	end
end
