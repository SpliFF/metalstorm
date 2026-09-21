# E2E2 D17 / D21 — the two halves of this brief that are design calls

journey-hud HUD4, 2026-09-21. D16, D19 and D20 were mechanical and are fixed
(see the commit). These two are not, for reasons that are findings in their own
right. Fold these into the defect rows in `README.md` "E2E pass 2".

---

## D17 — the chatter filter's chat half is dead

**The row understates it. Nothing passes `extra.scope` to `say()` because
there is no in-game chat at all.**

Measured this fire, not inferred:

* `schemas/protocol.fbs` has both halves of a chat wire — `ChatSend {text,
  destination}` (client→server, `destination` 0=all/1=allies/2=spectators) and
  `ChatReceive {sender_id, sender_name, text, destination}`.
* `rts/Server/ClientMessageHandler.cpp:2210` puts `ClientPayload_ChatSend` in
  the **explicitly-rejected** block, with the block's own comment naming it as
  a "protocol nicety with no server side today": it logs
  `rejecting unimplemented/ungated verb` and drops it.
* `ChatReceive` is never constructed anywhere in `rts/`. The only client
  references are the generated FlatBuffers accessors.
* `rts/Server/Chat.{h,cpp}` is the **lobby's** chat (flood/mute), not the
  game's.

So `chatterHidden(scope)` is not dead code that someone forgot to call — it is
the landing point for a producer that was never built, and its own comment says
exactly that ("the chat producer that would set it does not exist on the wire
yet"). PLAN-beta's "the console hides all-chat" is therefore not a HUD defect;
it is a feature with no wire, and no amount of work inside `client/` can make
it true.

**Options, in the order I would take them:**

1. **Amend PLAN-beta, keep the gate.** Change "the console hides all-chat" to
   "the console scopes battle moments to the player's own squads
   (`moment-hud.ts`)", which is what actually ships and what the live pass
   verified. Leave `chatterHidden` and `isChatterFiltered` exactly as they are,
   annotated as the landing point. **Cost: a paragraph.** This is the only
   option that makes the plan true this week.
2. **Build the wire** — ungate `ChatSend` in `ClientMessageHandler` with its own
   session+role check, route by `destination` against the sender's ally team,
   emit `ChatReceive`, and have the client call
   `say('chat', text, [], {scope})`. That is a server feature with mute/flood,
   spectator scoping and a moderation surface behind it; it is **not** a
   journey-hud change and it is not beta-sized. Owning lane would be a server
   lane, not this one.
3. **Delete the gate.** Cheapest to read, and wrong: it throws away the one
   piece of the feature that is correct, and the next person to build chat
   rebuilds it without the mentorship reasoning that produced it.

**Not done here** because 1 edits `PLAN-beta.md` — a shared plan file several
lanes are writing this week — and 2 is another lane's tree. Either needs a
human's word on which.

---

## D21 — an AllowCommand refusal is silent

The refusal is real and the row is right. The fix is not mine to make alone,
for a concrete reason:

* The only refusal site is `game_assignment.lua:222` `gadget:AllowCommand`,
  which returns a bare `false` (the Recruit equipment cap at
  `rankOf(pid) == 0 and countFor[pid] > 0`, and the `rp < rr` rank gate). The
  engine tells the client nothing about a vetoed command.
* **That file is journey-sim's, and journey-sim is actively in it**: D14 was
  fixed there this pass and D15's carve-retry fix is queued for the same
  `AllowCommand`/`carve` region. A second lane editing it now is a merge
  conflict by construction, so per the parallel-lane contract this stays
  serial.

**Options:**

1. **A coalesced refusal param (recommended).** `AllowCommand` cannot publish
   per call — a box-select of 20 squads refuses 20 times in one frame. Set a
   pending reason on the veto path and drain it from `gadget:GameFrame`:
   publish team-scope `refuse_<pid>_n` (monotonic) plus `refuse_<pid>_why`
   (`'scope'` | `'rank'`) and `refuse_<pid>_count`. The client watches `_n` for
   a change and the console says one line — *"3 squads didn't take that order —
   they're not yours to command"* / *"…that's <callsign>'s squad"*. One param
   write per frame at worst, and the client half is ~15 lines in `ui-store.ts`
   + `command-console.js`. **Owner: journey-sim for the gadget half; this lane
   can take the client half the moment the params exist.**
2. **Predict it client-side.** The store already has `getMyAssignments()`,
   `assignedBy()` and `rankOf()` — it can mirror the rule and warn *before*
   sending. Rejected as the primary fix: it is a second implementation of a
   sim rule that can silently diverge, which is the failure the declarative-UI
   rule exists to prevent. Worth having *in addition* to 1, as pre-order copy,
   never instead of it.
3. **Do nothing and document.** Not acceptable — this is the named
   "the game silently ignored me" failure.

**Not done here**: the gadget half, for the file-scope reason above. The client
half is ready to land behind it.
