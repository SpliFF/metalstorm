# sounds/ — native audio

Authored **`.webm`** (Opus) only (PLAN-metalstorm.md §9);
`gamedata/sounds.lua` references `.webm` names natively, so there is no
prune/extension-swap step by construction.

- Weapon families (kinetic: autocannon/MG/howitzer/railgun/mortar/missile/
  torpedo/flak/depth-charge) get per-scale variants matching
  `weapons/weapons.lua`
- **Every asset needs a row in `../ASSETS.md` first**
