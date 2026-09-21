// MentorSeat.h — which sides get the spawn-time AI mentor, and who it mentors.
//
// PLAN-beta-journey.md §(d). The lobby seats a `strategos:<team>:-1:mentor` AI
// when a Recruit is on a side with no Veteran. That seat used to be the WHOLE
// story, and it was invisible: the sim mirrors `mentor_<pid>` from the
// `mentorships` row (ClientMessageHandler's `journeyOf`), so a Recruit could
// deploy with an AI co-commander on their team while the HUD said "No mentor
// yet" and then offered them the mentor they already had — and accepting it
// would have opened a SECOND relationship, the one thing Mentorship.h's
// invariant exists to refuse (beta-e2e E2E2 D18).
//
// ── The reconciliation: the SEAT creates the ROW ───────────────────────────
// The row cannot drive the seat, because the row does not exist yet: nobody
// asked for an AI mentor — the lobby decided the Recruit needs one, and it can
// only decide that once the roster is final (that is why the seat is chosen at
// spawn and not at enlist). So the seat is authoritative and writes the row it
// implies, before the game server is forked and therefore before the first
// AuthRequest reads it. One source of truth, mirrored the existing way.
//
// The corollary is that an existing mentorship SUPPRESSES the seat. A Recruit
// already mentored by a human who is not in this room has a mentor; giving
// them a second one on the team is the same double-relationship in a different
// costume (E2E2 room 80 did exactly this).
//
// Pure decision, no SQLite and no roster type: the caller does both lookups
// (standing → tier, `Mentorship::ActiveFor` → mentored) and this says only
// which teams get a seat and which accounts get a row. That is what makes the
// rule testable without spawning a lobby.
#pragma once

#include <cstdint>
#include <map>
#include <vector>

namespace MentorSeat {

/// What the mentee's live `mentorships` row is, if any.
enum class Mentor {
    None,   ///< no offered and no active row
    Ai,     ///< the AI fallback (`kind == "ai"`)
    Human,  ///< a human mentor, offered or active
};

/// One non-spectator on the roster, already resolved against the accounts db.
struct Candidate {
    int64_t userId = 0;
    uint8_t team = 0;
    int     tier = 0;     ///< Standing::TierFor(users.standing)
    Mentor  mentor = Mentor::None;
};

struct Decision {
    /// Teams to append `strategos:<team>:-1:mentor` for, ascending.
    std::vector<uint8_t> teams;
    /// Accounts that need an `ai`/`active` mentorship row written, in roster
    /// order. Always a subset of the Recruits on `teams`.
    std::vector<int64_t> mentees;
};

/// A side gets the seat iff it holds at least one Recruit who is mentored by
/// the AI or by nobody, and no Veteran (tier ≥ 2). A row is written only for
/// the ones mentored by nobody — a Recruit whose AI mentorship is already live
/// (their second mission in the same room, say) still needs the AI *present*,
/// but Offer would refuse a second row and be right to.
///
/// A HUMAN mentorship — even with someone who is not in this room — suppresses
/// both. They have a mentor; a second one on the team is the double
/// relationship Mentorship.h refuses, wearing a different costume (E2E2 room
/// 80 was exactly this and got the seat anyway). So is a roster name the
/// accounts database cannot resolve (`userId == 0`): no row can be written for
/// it, and a seat nobody can be told about is the defect this file exists to
/// close.
inline Decision Decide(const std::vector<Candidate>& roster) {
    struct Side {
        bool veteran = false;
        bool wantsSeat = false;
        std::vector<int64_t> needRow;
    };
    std::map<uint8_t, Side> sides;
    for (const auto& c : roster) {
        auto& s = sides[c.team];
        if (c.tier >= 2)
            s.veteran = true;
        if (c.tier != 0 || c.userId <= 0 || c.mentor == Mentor::Human)
            continue;
        s.wantsSeat = true;
        if (c.mentor == Mentor::None)
            s.needRow.push_back(c.userId);
    }
    Decision d;
    for (auto& [team, s] : sides) {
        if (s.veteran || !s.wantsSeat)
            continue;
        d.teams.push_back(team);
        d.mentees.insert(d.mentees.end(), s.needRow.begin(), s.needRow.end());
    }
    return d;
}

}  // namespace MentorSeat
