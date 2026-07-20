
## 29. Case study — the land train (shipped)

Four independent units — fable_train_engine / _gun / _troop / _cargo —
that game code couples into one articulated consist. The design brief
made the units-joined-by-code architecture explicit, and every prior
contract pattern got reused at once.

**The consist contract.** Each unit ships `link_f`/`link_r` empties at
its coupler knuckles (both ends — the engine too, so the same model
drives from either end of the train, placed reversed at the rear).
Game-side, a gadget binds car link_f → leader link_r exactly the way
transports AttachUnit passengers (§23) or pads bind aircraft (§25),
drives the lead engine and slaves the rest of the chain. Axle pieces
(axle1..axleN, big exposed 8-gon wheel pairs) are the wheel-spin
script API — wheels not tracks, per the brief.

**A chassis function is the family.** One `chassis()` builds hull,
wheel fenders, inter-axle skirt segments, coupler knuckles and deck
bulwarks for all four units; car types differ only in superstructure
(twin fore/aft-baked howitzer turrets per §22 for the gun car; port
rows + cupolas for the troop car; stake bed + lashed cargo for the
equipment car). The shared C_SIDE band means every carriage inherits
the same plating, port row and weathering — visual consist coherence
for free, exactly like §28's civkit but with a military vocabulary.

**Firing ports are paint + normals, not geometry.** A 32 cm slot,
shutter hinge and bolt pair every 1.7 m along the carriage band, with
hm.rect recesses — reads perfectly at RTS zoom, costs zero tris, and
lands on every car type (the cargo car's stake walls sample the same
rows: its "ports" per the brief came free).

**Flame without a flame weapon.** No MS_FLAME family exists; the troop
car's second cupola is a flame KIT visually (twin fuel drums, flared
nozzle, GLOWZ pilot-light cap) bound to MS_MG_S1, flagged
customparams.flame_visual for rebinding when the weapon family lands.
Model the intent, bind what exists, flag the gap.

**Gotchas.** Deck handrails at 0.06 thickness render as solid parapet
walls — bulwarks ≤0.25 tall or true post+rail construction only. A
stale http.server from a previous cwd serves 404s that look like
loader hangs — `pkill -f 'http.server 8899'` before restarting. And
substring URI rewrites bite: 'orm' matches inside 'n**orm**als' —
match '_<kind>.' with a break (the §28 rewrite is now fixed to do so).

**Unitdefs.** One family file `units/fable_train.lua` with a shared
`common` table: engine (railgun + flak, footprintz 9), gun car (2×
howitzer + MG), troop car (transportcapacity 8 — a rifle squad — plus
2 cupolas), cargo car (transportcapacity 2 size 2 for light vehicles).
All carry customparams.couple_links + train_role for the consist
gadget.
