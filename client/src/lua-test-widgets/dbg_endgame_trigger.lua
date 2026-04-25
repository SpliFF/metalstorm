function widget:GetInfo()
	return {
		name      = "Endgame Window Test Trigger",
		desc      = "Solo-mode shim. Provides a mock WG.MakeStatsPanel so the Chili EndGame Window can run without gui_chili_endgraph, and fires GameOver after a delay so the window actually appears.",
		author    = "engine",
		date      = "2026-04-26",
		license   = "GPLv2",
		layer     = 1,
		enabled   = true,
		handler   = false,
	}
end

-- Top-level executes during cawidgets LoadWidget, BEFORE any widget's
-- Initialize callin runs. Endgame Window's Initialize calls
-- WG.MakeStatsPanel(), so it must already be set by then.
if not WG.MakeStatsPanel then
	WG.MakeStatsPanel = function()
		local Chili = WG.Chili
		if not Chili then return nil end
		local panel = Chili.Panel:New{
			x = 0, y = 0, right = 0, bottom = 0,
			backgroundColor = {0.15, 0.15, 0.2, 1},
		}
		Chili.Label:New{
			parent  = panel,
			x       = 16, y = 16,
			autosize = true,
			caption = "stats panel mock — solo test",
			font    = { size = 14, color = {1, 1, 0.6, 1} },
		}
		-- gui_chili_endgamewindow:Update does
		--   statsSubPanel.graphButtons[1].OnClick[1](statsSubPanel.graphButtons[1])
		-- so we have to expose a button shape with a no-op callback.
		panel.graphButtons   = { [1] = { OnClick = { function(_) end } } }
		panel.buttonPressed  = 1
		return panel
	end
end

local triggered    = false
local triggerDelay = 1.5
local startTime

function widget:Initialize()
	startTime = Spring.GetGameSeconds()
	Spring.Echo("[EndgameTrigger] armed; firing GameOver in " .. triggerDelay .. "s")
end

function widget:Update(_dt)
	if triggered then return end
	if (Spring.GetGameSeconds() - startTime) < triggerDelay then return end
	triggered = true

	local widgets = widgetHandler and widgetHandler.widgets
	if not widgets then
		Spring.Echo("[EndgameTrigger] widgetHandler.widgets not available")
		return
	end
	for _, w in ipairs(widgets) do
		if w.whInfo and w.whInfo.name == "Chili EndGame Window" and w.GameOver then
			local ok, err = pcall(w.GameOver, w, { Spring.GetMyAllyTeamID() or 0 })
			if ok then
				Spring.Echo("[EndgameTrigger] GameOver fired")
			else
				Spring.Echo("[EndgameTrigger] GameOver error: " .. tostring(err))
			end
			return
		end
	end
	Spring.Echo("[EndgameTrigger] Chili EndGame Window not found in widgetHandler.widgets")
end
