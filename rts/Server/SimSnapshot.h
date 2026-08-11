// SimSnapshot — the purpose-written synced-state walk behind ISimSerializer
// (PLAN-persistence.md Q-P1 option B, task 1b).
//
// WHAT THIS IS
// ------------
// GameStateStore owns everything *around* a snapshot — framing, integrity,
// atomic commits, retention, the E1/E2 ladders — and takes an opaque payload
// from an ISimSerializer. This module is that serializer: a hand-written walk
// over the server's own synced state, modelled on the existing wire
// serializers (EntityStateSerializer, ProjectileStateSerializer,
// PieceStateSerializer, BuildActivitySerializer) rather than on creg, which is
// stubbed out in this tree and is not coming back (Q-P1's decision block).
//
// SECTIONS, AND WHY THE UNIMPLEMENTED ONES ARE *DECLARED*
// ------------------------------------------------------
// The payload is a list of self-describing sections. Every part of the synced
// state the walk must eventually cover has a SectionSpec here — including the
// parts that are not written yet. That is the point: option B's one real
// weakness is a piece of synced state silently vanishing on resume, so the
// gaps are enumerated in code, reported by MissingSections(), and asserted by
// the tripwire in tests/test_sim_snapshot.cpp. An unimplemented required
// section makes Serialize() *refuse by name* — there is no configuration in
// which this module hands the store a payload it knows is incomplete.
//
// LAYOUT HASH
// -----------
// Q-P1 constraint 3 says the layout hash must move on every shape change, and
// notes the E1 refusal is only load-bearing if it actually does. Relying on an
// author to remember is the failure mode, so LayoutHash() is *derived* from
// the section table: every section carries a version, the hash folds
// (id, version) for each, and the only way to change what a section emits
// without changing the hash is to change the emit code and not its version —
// which the round-trip tests catch, because they are written against the
// shape.
//
// COVERAGE CONTRACT — what a restored world is, and is not
// -------------------------------------------------------
// A restored snapshot reinstates synced state the server owns *authoritatively
// and durably*. It deliberately does not attempt to reinstate state the sim
// rebuilds on its own within a tick or two (LOS/radar maps, quad-field
// membership, path caches): those are derived, and a walk that wrote them
// would be claiming a fidelity it cannot check. Anything derived is listed in
// kDerivedNotCaptured below with the reason, so "not in the payload" is never
// ambiguous between "rebuilt" and "forgotten".
//
// PURITY
// ------
// Unlike GameStateStore this module DOES touch sim globals (gs, gsRNG,
// standingOrders, orgGroups, directiveManager) — that is its job. It links
// into spring-tests, which builds the full sim sources, so the round-trip
// guarantees are covered by plain doctests.
#pragma once

#include "Server/GameStateStore.h"   // gamestate::ISimSerializer
#include "Server/StandingOrders.h"   // StandingOrder(Conditions) (census)
#include "Server/OrgGroups.h"        // OrgGroup, Directive (census)

#include <cstdint>
#include <string>
#include <vector>

namespace simsnapshot {

/// Section identity. Values are stable and are NEVER reused — a section that
/// is retired leaves its number burned, so an old blob can still be told apart
/// from a new one that happens to occupy the same slot.
enum class SectionId : uint16_t {
    Globals        = 1,  ///< sim frame + synced RNG position
    StandingOrders = 2,  ///< StandingOrderManager (Q-P1 constraint 2)
    OrgGroups      = 3,  ///< OrgGroupManager (Q-P1 constraint 2)
    Directives     = 4,  ///< DirectiveManager (rides with OrgGroups)
    Teams          = 5,  ///< resources, statistics, rulesParams — task 1c
    Units          = 6,  ///< unitHandler + command queues — task 1c
    SyncedLua      = 7,  ///< gadget-owned synced Lua state — task 1d
};

/// One entry per part of the synced state the walk must cover. `implemented`
/// false is a declaration of a known gap, not an oversight — `note` says which
/// milestone owns it.
struct SectionSpec {
    SectionId   id;
    uint16_t    version;      ///< bump on ANY change to what this section emits
    const char* name;
    bool        implemented;
    const char* note;
};

/// The section table. Stable order; the payload is written in this order.
const std::vector<SectionSpec>& Sections();

/// Names of the declared-but-unimplemented sections, in table order. Empty
/// means the walk is complete and the serializer may be attached to the store.
std::vector<std::string> MissingSections();

/// Synced state that is deliberately NOT in the payload because the sim
/// rebuilds it, paired with what rebuilds it. Reported at boot alongside
/// MissingSections() so the two kinds of absence are never confused.
struct DerivedOmission {
    const char* what;
    const char* rebuiltBy;
};
const std::vector<DerivedOmission>& DerivedNotCaptured();

/// Payload framing version. Independent of the section versions: this is the
/// envelope (section count + per-section header), not the contents.
inline constexpr uint16_t kPayloadVersion = 1;

// ──────────────────── The field-census tripwire ────────────────────
//
// Q-P1 constraint 4: "ship a completeness tripwire in the same milestone as
// the walk, not after it". Each function below destructures every member of
// the struct it names and returns the member count, so a field added to any
// of them is a BUILD failure on that struct rather than a field that silently
// stops being snapshotted. tests/test_sim_snapshot.cpp pins the counts against
// the number of fields the codec writes, which is what makes "the build still
// compiles" and "the walk still covers everything" the same statement.
namespace census {
int Conditions(const StandingOrderConditions& c);
int Order(const StandingOrder& o);
int Group(const OrgGroup& g);
int Directive_(const Directive& d);
} // namespace census

class SimSnapshotSerializer : public gamestate::ISimSerializer {
public:
    bool Serialize(std::vector<uint8_t>& out, std::string& err) override;
    bool Deserialize(const uint8_t* data, size_t size, std::string& err) override;
    uint64_t LayoutHash() const override;
    int32_t Frame() const override;

    /// The walk itself, WITHOUT the completeness gate — it emits the sections
    /// that are implemented and says nothing about the ones that are not.
    ///
    /// NOT a checkpoint. Serialize() is the only entry point that may produce
    /// a payload for the store, because a payload missing a declared section
    /// restores a partial world. This exists so the landed sections have
    /// round-trip coverage while the walk is incomplete (a milestone that
    /// shipped them untested until task 1d would be worse), and so tasks
    /// 1c/1d have the body to extend. Deserialize() needs no equivalent: it
    /// reads whatever sections the payload carries.
    bool SerializeImplemented(std::vector<uint8_t>& out, std::string& err);
};

} // namespace simsnapshot
