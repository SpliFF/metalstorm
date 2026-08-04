// Tests for the org-group registry (Model A) + macro-directive manager.
// Covers the pure registry / CRUD logic (roster churn, the one-platoon rule,
// echelon/parent rejection, directive↔group linkage, cross-team ownership,
// demand-model scope mirroring). The evaluator's decomposition needs a live
// sim (unitHandler) and is exercised by the running server — same as the
// landed StandingOrderManager, which is likewise integration-tested.
//
// See PLAN-macro-orders.md / PLAN-macro-directives.md.

#include <doctest/doctest.h>
#include "Server/OrgGroups.h"

namespace {
void resetManagers() {
    orgGroups.Clear();
    directiveManager.Clear();
    orgGroups.SetChangeNotifier(nullptr);
    directiveManager.SetChangeNotifier(nullptr);
}
}

TEST_SUITE("OrgGroupManager") {
    TEST_CASE("create returns a monotonic id and stores metadata") {
        resetManagers();
        const uint32_t a = orgGroups.Create(1, Echelon::Platoon, "3rd Armoured",
                                            {10, 11, 12}, 0, 100);
        const uint32_t b = orgGroups.Create(1, Echelon::Platoon, "1st Recon",
                                            {}, 0, 100);
        CHECK(a == 1);
        CHECK(b == 2);
        const OrgGroup* g = orgGroups.Get(a);
        REQUIRE(g != nullptr);
        CHECK(g->team == 1);
        CHECK(g->echelon == Echelon::Platoon);
        CHECK(g->name == "3rd Armoured");
        CHECK(g->members.size() == 3);
        CHECK(g->createdAtFrame == 100);
    }

    TEST_CASE("army echelon and non-zero parent are rejected in v0") {
        resetManagers();
        CHECK(orgGroups.Create(1, Echelon::Army, "Battlegroup", {}, 0, 0) == 0);
        CHECK(orgGroups.Create(1, Echelon::Platoon, "child", {}, 5, 0) == 0);
        // A valid platoon still works.
        CHECK(orgGroups.Create(1, Echelon::Platoon, "ok", {}, 0, 0) == 1);
    }

    TEST_CASE("seed roster de-dups") {
        resetManagers();
        const uint32_t g = orgGroups.Create(1, Echelon::Platoon, "g", {7, 7, 8}, 0, 0);
        CHECK(orgGroups.Get(g)->members.size() == 2);
    }

    TEST_CASE("one-platoon rule: adding to a second group pulls from the first") {
        resetManagers();
        const uint32_t a = orgGroups.Create(1, Echelon::Platoon, "A", {10, 11}, 0, 0);
        const uint32_t b = orgGroups.Create(1, Echelon::Platoon, "B", {}, 0, 0);
        CHECK(orgGroups.GroupOfUnit(10) == a);

        orgGroups.Update(b, 1, {10}, {}, "");
        CHECK(orgGroups.GroupOfUnit(10) == b);
        CHECK(orgGroups.IsMember(a, 10) == false);
        CHECK(orgGroups.IsMember(b, 10) == true);
        // 11 stayed in A.
        CHECK(orgGroups.GroupOfUnit(11) == a);
    }

    TEST_CASE("update roster add/remove and rename; empty name preserved") {
        resetManagers();
        const uint32_t g = orgGroups.Create(1, Echelon::Platoon, "orig", {1, 2}, 0, 0);
        orgGroups.Update(g, 1, {3}, {1}, "renamed");
        const OrgGroup* p = orgGroups.Get(g);
        CHECK(p->name == "renamed");
        CHECK(orgGroups.IsMember(g, 1) == false);
        CHECK(orgGroups.IsMember(g, 3) == true);
        // Empty name = keep existing.
        orgGroups.Update(g, 1, {}, {}, "");
        CHECK(orgGroups.Get(g)->name == "renamed");
    }

    TEST_CASE("cross-team edits are rejected") {
        resetManagers();
        const uint32_t g = orgGroups.Create(1, Echelon::Platoon, "g", {}, 0, 0);
        CHECK(orgGroups.Update(g, 2, {5}, {}, "hax") == false);
        CHECK(orgGroups.Disband(g, 2) == false);
        CHECK(orgGroups.SetPosture(g, 2, "{}") == false);
        // Owner succeeds.
        CHECK(orgGroups.Update(g, 1, {5}, {}, "") == true);
        CHECK(orgGroups.SetPosture(g, 1, "{\"roe\":\"free\"}") == true);
        CHECK(orgGroups.Get(g)->postureJson == "{\"roe\":\"free\"}");
    }

    TEST_CASE("disband removes the group") {
        resetManagers();
        const uint32_t g = orgGroups.Create(1, Echelon::Platoon, "g", {1}, 0, 0);
        CHECK(orgGroups.Disband(g, 1) == true);
        CHECK(orgGroups.Get(g) == nullptr);
        CHECK(orgGroups.GroupOfUnit(1) == 0);
    }

    TEST_CASE("GetTeamGroups filters by team, id-ordered") {
        resetManagers();
        orgGroups.Create(1, Echelon::Platoon, "t1a", {}, 0, 0);
        orgGroups.Create(2, Echelon::Platoon, "t2",  {}, 0, 0);
        orgGroups.Create(1, Echelon::Platoon, "t1b", {}, 0, 0);
        auto team1 = orgGroups.GetTeamGroups(1);
        REQUIRE(team1.size() == 2);
        CHECK(team1[0]->id < team1[1]->id);
        CHECK(orgGroups.GetTeamGroups(2).size() == 1);
    }
}

TEST_SUITE("DirectiveManager") {
    TEST_CASE("create mirrors the group scope into conditions and links the group") {
        resetManagers();
        const uint32_t g = orgGroups.Create(1, Echelon::Platoon, "g", {1, 2}, 0, 0);
        StandingOrderConditions cond;
        const uint32_t d = directiveManager.Create(
            1, DirectiveType::Defend, 50, OrderShape::Circle,
            {100, 0, 200, 300}, cond, g, 0, "", 0, 0);
        REQUIRE(d != 0);
        const auto& all = directiveManager.GetAllDirectives();
        REQUIRE(all.size() == 1);
        CHECK(all[0].groupId == g);
        CHECK(all[0].conditions.orgGroup == g);   // scope mirrored
        CHECK(orgGroups.Get(g)->currentDirectiveId == d);  // group links back
    }

    TEST_CASE("condition-scoped directive keeps orgGroup 0") {
        resetManagers();
        StandingOrderConditions cond;
        const uint32_t d = directiveManager.Create(
            1, DirectiveType::DefendFront, 40, OrderShape::Polyline,
            {600, 0, 0, 0, 100, 0, 100}, cond, 0, 2000, "", 0, 0);
        REQUIRE(d != 0);
        CHECK(directiveManager.GetAllDirectives()[0].conditions.orgGroup == 0);
        CHECK(directiveManager.GetAllDirectives()[0].requestedStrength == 2000);
    }

    TEST_CASE("update rewrites fields but the scope group is immutable") {
        resetManagers();
        const uint32_t g = orgGroups.Create(1, Echelon::Platoon, "g", {}, 0, 0);
        StandingOrderConditions cond;
        const uint32_t d = directiveManager.Create(
            1, DirectiveType::Defend, 10, OrderShape::Point, {0, 0, 0},
            cond, g, 0, "", 0, 0);
        StandingOrderConditions cond2;
        cond2.orgGroup = 999;   // caller tries to re-scope — must be overridden
        CHECK(directiveManager.Update(d, 1, DirectiveType::Assault, 80,
                                      OrderShape::Circle, {1, 2, 3, 4}, cond2,
                                      500, "", true) == true);
        const auto& dd = directiveManager.GetAllDirectives()[0];
        CHECK(dd.type == DirectiveType::Assault);
        CHECK(dd.priority == 80);
        CHECK(dd.requestedStrength == 500);
        CHECK(dd.groupId == g);
        CHECK(dd.conditions.orgGroup == g);   // stayed pinned to the scope group
    }

    TEST_CASE("cross-team update / remove rejected") {
        resetManagers();
        StandingOrderConditions cond;
        const uint32_t d = directiveManager.Create(
            1, DirectiveType::Defend, 10, OrderShape::Point, {0, 0, 0},
            cond, 0, 0, "", 0, 0);
        CHECK(directiveManager.Update(d, 2, DirectiveType::Defend, 10,
                                      OrderShape::Point, {0, 0, 0}, cond, 0, "",
                                      true) == false);
        CHECK(directiveManager.Remove(d, 2) == false);
        CHECK(directiveManager.Remove(d, 1) == true);
    }

    TEST_CASE("remove clears the group's current directive link") {
        resetManagers();
        const uint32_t g = orgGroups.Create(1, Echelon::Platoon, "g", {}, 0, 0);
        StandingOrderConditions cond;
        const uint32_t d = directiveManager.Create(
            1, DirectiveType::Defend, 10, OrderShape::Point, {0, 0, 0},
            cond, g, 0, "", 0, 0);
        CHECK(orgGroups.Get(g)->currentDirectiveId == d);
        directiveManager.Remove(d, 1);
        CHECK(orgGroups.Get(g)->currentDirectiveId == 0);
    }

    TEST_CASE("RemoveForGroup drops all of a group's directives") {
        resetManagers();
        const uint32_t g = orgGroups.Create(1, Echelon::Platoon, "g", {}, 0, 0);
        StandingOrderConditions cond;
        directiveManager.Create(1, DirectiveType::Defend, 10, OrderShape::Point,
                                {0, 0, 0}, cond, g, 0, "", 0, 0);
        directiveManager.Create(1, DirectiveType::Withdraw, 20, OrderShape::Point,
                                {0, 0, 0}, cond, 0, 0, "", 0, 0);  // condition-scoped
        directiveManager.RemoveForGroup(g);
        // Only the condition-scoped one survives.
        REQUIRE(directiveManager.GetAllDirectives().size() == 1);
        CHECK(directiveManager.GetAllDirectives()[0].groupId == 0);
    }

    TEST_CASE("GetTeamDirectives sorts priority desc then id asc") {
        resetManagers();
        StandingOrderConditions cond;
        const uint32_t lo = directiveManager.Create(1, DirectiveType::Defend, 10,
                                OrderShape::Point, {0, 0, 0}, cond, 0, 0, "", 0, 0);
        const uint32_t hi = directiveManager.Create(1, DirectiveType::Assault, 90,
                                OrderShape::Point, {0, 0, 0}, cond, 0, 0, "", 0, 0);
        auto list = directiveManager.GetTeamDirectives(1);
        REQUIRE(list.size() == 2);
        CHECK(list[0]->id == hi);   // higher priority first
        CHECK(list[1]->id == lo);
    }
}
