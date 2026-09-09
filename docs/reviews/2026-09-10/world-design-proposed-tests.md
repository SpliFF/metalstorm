# Proposed doctest cases for the 2026-09-10 world-design patches (TEXT ONLY)

These are written against the fixtures the existing `tests/test_world_*.cpp`
files already define (`SeasonDb`, `StagingDb`, the stats fixture's
`Found()/Grant()/Settle()` helpers). They are **not** added to the test
target — C++ cannot be compiled this session. Each case names the patch it
guards (`docs/reviews/2026-09-10/world-design.md` P1–P12) and is written so
it FAILS on today's tree and PASSES after the patch.

```cpp
// ─── P1: victory attribution compares side keys (F1) ───────────────────────
TEST_CASE("review F1: a commander whose FACTION fields the winning SIDE is awarded the victory rate") {
    StatsDb h;
    // Found() must bind a side key now: the faction id is a slug, the side is sidedata's key.
    const auto vanguard = h.Found("Vanguard", /*account=*/1, /*sideKey=*/"compact");
    const auto cmdr = h.Grant(1, vanguard, "poi-a", /*authority=*/10.0, kNow);
    h.Settle("poi-a", /*winners=*/"compact");            // side key, exactly what WarStateSim writes
    const int awarded = WorldStats::AccrueFromSettlements(h.db, kW, h.Rules(), kNow + 1, kWorldNow);
    REQUIRE(awarded == 1);
    const auto ev = WorldStats::EventsFor(h.db, kW, cmdr.commanderId);
    REQUIRE(ev.size() == 1);
    CHECK(ev[0].reason == "victory");
    CHECK(ev[0].delta == doctest::Approx(h.Rules().authorityPerVictory));   // 12, not 3
}

TEST_CASE("review F1: a faction with no side key is never a victor, only a defender") {
    StatsDb h;
    const auto f = h.Found("Sideless", 1, /*sideKey=*/"");
    h.Grant(1, f, "poi-a", 10.0, kNow);
    h.Settle("poi-a", "compact");
    WorldStats::AccrueFromSettlements(h.db, kW, h.Rules(), kNow + 1, kWorldNow);
    CHECK(WorldStats::EventsFor(h.db, kW, "sideless-1")[0].reason == "defeat");
}

// ─── P2: the digest names world factions (F2) ──────────────────────────────
TEST_CASE("review F2: settlementsWon is credited to the WORLD faction whose claim won, plus a side bucket") {
    SeasonDb h;
    h.SetConfig("seasonLengthWorldMs", static_cast<double>(1 * kDayMs));
    const auto vanguard = h.Found("Vanguard", 1, "compact");
    WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);
    // file a claim, settle a war the compact side won, resolve it
    h.AddPoi("poi-a", "meridian_basin");
    const auto claim = WorldConquest::FileClaim(h.db, h.ConquestRules(), h.FactionRules(),
                                                {kW, "poi-a", vanguard, 1}, kWorldNow, kNow);
    REQUIRE(claim.ok);
    const int64_t sid = h.Settle("poi-a", "compact", kNow + 10);
    WorldConquest::SettleWar(h.db, h.SettlementById(sid), h.ConquestRules(), kWorldNow + 1, kNow + 11);
    const auto r = WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow + 2 * kDayMs, kNow + 40);
    REQUIRE(r.rolledOver);
    const auto digests = WorldSeasons::DigestsFor(h.db, kW, 1);
    CHECK(DigestOf(digests, vanguard)->settlementsWon == 1);        // the faction
    CHECK(DigestOf(digests, "side:compact")->settlementsWon == 1);  // the side
    CHECK(!DigestOf(digests, "compact").has_value());               // never a bare side key
}

// ─── P3: rollover is atomic; a world with ended-but-no-active season continues numbering (F3, F17) ─
TEST_CASE("review F3: a world whose active season vanished re-opens season N+1, never season 1 again") {
    SeasonDb h;
    h.SetConfig("seasonLengthWorldMs", static_cast<double>(1 * kDayMs));
    WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);
    REQUIRE(WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow + 2 * kDayMs, kNow + 1).rolledOver);
    // simulate the crash window: season 2 closed, nothing opened
    h.Exec("UPDATE world_seasons SET state='ended', ended_world_ms=1 WHERE season_number=2");
    REQUIRE(!WorldSeasons::CurrentSeason(h.db, kW).has_value());
    WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow + 3 * kDayMs, kNow + 2);
    const auto cur = WorldSeasons::CurrentSeason(h.db, kW);
    REQUIRE(cur.has_value());
    CHECK(cur->seasonNumber == 3);
}

TEST_CASE("review F17: seasonLengthWorldMs <= 0 disables seasons rather than rolling every tick") {
    SeasonDb h;
    h.SetConfig("seasonLengthWorldMs", 0.0);
    WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);
    CHECK(!WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow + 10 * kDayMs, kNow + 1).rolledOver);
}

// ─── P4: a no-winner ending voids the escrow (F4) ──────────────────────────
TEST_CASE("review F4: voided returns everything, captures nothing, pays no spoils") {
    WorldEscrowRules rules;
    const auto p = PayoutFor(WorldEscrowOutcome::Voided, 4, 12, 0.0, rules);
    CHECK(p.returnTransports == 4);
    CHECK(p.returnSquads == 12);
    CHECK(p.captureTransports == 0);
    CHECK(p.captureSquads == 0);
    CHECK(std::string(WorldEscrowOutcomeToString(WorldEscrowOutcome::Voided)) == "voided");
}

TEST_CASE("review F4: settling a staging as voided leaves the faction's force balance at zero net") {
    EscrowDb h;
    const auto atk = h.Found("Attackers", 1, "compact");
    const auto st  = h.CommitAndEngage(atk, "target", /*transports=*/2, /*squads=*/6, /*roomId=*/77);
    WorldEscrowSettleFacts facts;
    facts.outcome = WorldEscrowOutcome::Voided;
    const auto res = WorldEscrow::Settle(h.db, st.stagingId, facts, WorldEscrowRules{}, kWorldNow, kNow);
    REQUIRE(res.settled);
    const auto bal = WorldEscrow::ForceBalanceFor(h.db, kW, atk);
    CHECK(bal.transports == 0);
    CHECK(bal.squads == 0);
    CHECK(WorldEconomy::TreasuryFor(h.db, kW, atk) == doctest::Approx(0.0));   // no war_spoils
}

// ─── P5: a join cannot land on a window the sweep just closed (F5) ─────────
TEST_CASE("review F5: joining a window that materialised under us is refused, and opens no escrow") {
    StagingDb h;
    const auto atk = h.Found("Attackers", 1, "compact");
    h.AddPoi("target", "meridian_basin");
    const auto first = h.Commit("target", atk, 1, 1);
    REQUIRE(first.ok);
    REQUIRE(WorldStaging::MarkMaterialised(h.db, first.staging.stagingId, 42, kNow));
    // A second commit by the same faction at the same POI: the only open row is gone.
    // Today: a fresh row opens (fine). The race the patch closes is the UPDATE-after-read;
    // drive it by materialising between OpenFor and the UPDATE via the test hook
    // `WorldStaging::TestHooks::beforeJoinUpdate`, then assert:
    WorldStaging::TestHooks::beforeJoinUpdate = [&](int64_t id) { WorldStaging::MarkMaterialised(h.db, id, 43, kNow); };
    const auto second = h.Commit("target", atk, 1, 1);
    CHECK(second.error == "window_closed");
    CHECK(WorldEscrow::ForStaging(h.db, first.staging.stagingId).size() == 1);   // no orphan escrow row
}

// ─── P6: origin is verified and transit is a path (F6) ─────────────────────
TEST_CASE("review F6: an origin the faction does not hold is refused") {
    StagingDb h;
    const auto atk = h.Found("Attackers", 1, "compact");
    h.AddPoi("home", "");  h.AddPoi("near", ""); h.AddPoi("target", "meridian_basin");
    h.AddEdge("near", "target", 1 * kHourMs);
    const auto res = h.CommitFrom("target", atk, /*origin=*/"near");
    CHECK(res.error == "bad_origin");
}

TEST_CASE("review F6: a two-hop march is priced as the path sum, not the default") {
    std::vector<WorldPoiEdgeRecord> edges = {
        h.Edge("a", "b", 5 * kHourMs), h.Edge("b", "c", 7 * kHourMs) };
    CHECK(CheapestTransitTo(edges, {"a"}, "c") == 12 * kHourMs);
    CHECK(CheapestTransitTo(edges, {"c"}, "a") == 12 * kHourMs);       // bidirectional both ways
    edges[1].bidirectional = false;
    CHECK(CheapestTransitTo(edges, {"c"}, "a") == 0);                  // one-way blocks the return
}

// ─── P7: a row retired by a lowered budget is failed and refunded (F7) ─────
TEST_CASE("review F7: lowering the retry budget below a row's attempts fails it and releases its escrow") {
    StagingDb h;
    const auto atk = h.Found("Attackers", 1, "compact");
    h.AddPoi("target", "meridian_basin");
    const auto res = h.Commit("target", atk, 2, 4);
    REQUIRE(WorldEscrow::Open(h.db, res.staging, 2, 4, 1, kNow));
    auto rules = h.Rules();
    for (int i = 0; i < 2; ++i) WorldStaging::MarkAttemptFailed(h.db, res.staging.stagingId, "boom", rules, kNow);
    h.SetConfig("stagingMaterialiseMaxAttempts", 2);
    h.RunStagingSweep(res.staging.endsAtWorldMs);   // the sweep's retire pass (P7)
    CHECK(WorldStaging::Load(h.db, res.staging.stagingId)->state == WorldStagingState::Failed);
    CHECK(WorldEscrow::ForceBalanceFor(h.db, kW, atk).transports == 0);
}

// ─── P8: won-flip and transfer are one transaction (F8) ────────────────────
TEST_CASE("review F8: if the ownership write fails the claim stays open for the next settlement") {
    ConquestDb h;
    // ... file a claim, settle a war the claimant's side won ...
    WorldDirector::TestHooks::failNextSetPoiOwner = true;
    const auto r = WorldConquest::SettleWar(h.db, settlement, h.Rules(), kWorldNow, kNow);
    CHECK(!r.ownershipChanged);
    CHECK(WorldConquest::Load(h.db, claimId)->state == WorldClaimState::Open);   // not stranded as 'won'
    CHECK(WorldDirector::LoadPoi(h.db, kW, "poi-a")->ownerFactionId == previousOwner);
}

// ─── P9: commit-time refusals (F9, F18, F20) ───────────────────────────────
TEST_CASE("review F9: a side-less faction cannot commit, and same-side attacks are refused at commit") {
    StagingDb h;
    const auto sideless = h.Found("Sideless", 1, "");
    h.AddPoi("target", "meridian_basin");
    CHECK(h.Commit("target", sideless).error == "no_side");
    const auto owner = h.Found("Owners", 2, "compact");
    const auto ally  = h.Found("Allies", 3, "compact");
    WorldDirector::SetPoiOwner(h.db, kW, "target", owner);
    CHECK(h.Commit("target", ally).error == "same_side");
}

TEST_CASE("review F20: a commit above the per-commit cap is refused") {
    StagingDb h;
    const auto atk = h.Found("Attackers", 1, "compact");
    h.AddPoi("target", "meridian_basin");
    CHECK(h.Commit("target", atk, /*transports=*/17, /*squads=*/1).error == "too_much_force");
}

TEST_CASE("review F18: a claim on a world-only POI, or by a side-less faction, is refused at filing") {
    ConquestDb h;
    h.AddPoi("fen", "");
    CHECK(WorldConquest::FileClaim(h.db, h.Rules(), h.FactionRules(), {kW, "fen", claimant, 1}, kWorldNow, kNow).error == "no_battle_map");
    const auto sideless = h.Found("Sideless", 9, "");
    h.AddPoi("battleground", "meridian_basin");
    CHECK(WorldConquest::FileClaim(h.db, h.Rules(), h.FactionRules(), {kW, "battleground", sideless, 9}, kWorldNow, kNow).error == "no_side");
}

// ─── P10: escrow keys are in WorldDefaults (F12) ───────────────────────────
TEST_CASE("review F12: a new world's config blob carries the escrow rates") {
    const auto j = WorldDefaults{}.ToJson();
    CHECK(j["escrowAnnihilatedCaptureFraction"] == 0.25);
    CHECK(j["escrowWithdrewThresholdFraction"] == 0.5);
    CHECK(j["escrowHeldSpoilsTreasury"] == 25.0);
}

// ─── P12: MergeDefaults tolerates a mistyped key (F16) ─────────────────────
TEST_CASE("review F16: a string-typed budget key falls back to the default instead of throwing at boot") {
    SeederDb h;
    h.SetConfigRaw(R"({"poiBudgetInitial":"eight"})");
    CHECK_NOTHROW(WorldMapSeeder::SeedFromRegistry(h.db, kW, kNow, 0));
    CHECK(WorldDirector::PoisFor(h.db, kW).size() == 5);   // the whole registry fits the default budget of 8
}
```

Helper additions implied above (all test-only): `Found(name, account,
sideKey)` overloads binding `world_factions.side_key`; `EscrowDb::CommitAndEngage`;
`StagingDb::CommitFrom`/`RunStagingSweep`; `WorldStaging::TestHooks::beforeJoinUpdate`
and `WorldDirector::TestHooks::failNextSetPoiOwner` (a `static
std::function`/`bool` compiled only under the test target's `-DWORLD_TEST_HOOKS`).
