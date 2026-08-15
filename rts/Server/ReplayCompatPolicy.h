/**
 * Replay admission policy (PLAN-protocol-guard task 7).
 *
 * A recorded cause stream is bytes off the wire (syncedinput::InputKind::
 * ClientMessage records hold the undecoded ClientMessage frame, deliberately —
 * see SyncedInputJournal.h). Re-feeding those bytes through a binary built from
 * a DIFFERENT protocol.fbs is the same failure the handshake guard exists to
 * stop, one layer over: flatbuffers has no self-describing tag, so a field that
 * moved decodes as whatever now occupies its slot. The replay does not fail —
 * it plays a game nobody played, and `--replay --verify` reports the divergence
 * at whatever frame the mis-decode first changed the sim, which is nowhere near
 * the cause.
 *
 * So the rule is the handshake's rule with the client replaced by the file:
 * strict equality against this build's own SCHEMA_HASH, and an ABSENT hash is
 * refused identically (§2.2: pre-guard journals span the two known wire breaks,
 * so none of them is trustworthy anyway; there is no migration and no
 * converter — see §5's non-goals).
 *
 * WHERE THIS IS APPLIED, AND WHERE IT DELIBERATELY IS NOT
 * ------------------------------------------------------
 * `replay::Player::Load` — the re-execution ingest, the only path that feeds
 * recorded bytes back into a decoder. NOT `replay::Load`/`LoadSummary`, which
 * back the `.msr` packer and the replay browser: repacking a stale recording
 * and listing its date/outcome are lossless operations that decode no payload,
 * and refusing them would make an unplayable file also unreadable, which helps
 * nobody. A listing therefore still shows a pre-guard recording; what it cannot
 * do is play it.
 *
 * Header-only and dependency-free apart from the generated hash, so the rule is
 * covered by a plain doctest rather than only by a server that has to boot.
 */
#pragma once

#include "ProtocolSchemaHash.h"

#include <string>
#include <string_view>

namespace replay {

/// Verdict on one recording's header. `error` is what `--replay` prints and is
/// the only thing an operator sees, so it names BOTH hashes: "schema mismatch"
/// without the values cannot distinguish a stale file from a stale binary.
struct CompatVerdict {
    bool accepted = false;
    std::string error;
};

/// First 12 chars of a hash for a human-readable message; "<none>" when the
/// recording carries no hash at all, so the two failure modes never read alike.
/// Same spelling as Protocol::ShortSchemaHash on purpose — an operator reading
/// a server log and a replay refusal should see one vocabulary.
inline std::string ShortSchemaHash(std::string_view hash) {
    if (hash.empty()) return "<none>";
    return std::string(hash.substr(0, 12));
}

/// Apply the rule. `recordedHash` is `Header::schemaHash`, empty for a file
/// written before task 7. `currentHash` defaults to this build's own constant
/// and is a parameter only so a test can drive both sides.
inline CompatVerdict CheckSchemaHash(
    std::string_view recordedHash,
    std::string_view currentHash = std::string_view{Protocol::SCHEMA_HASH}) {
    CompatVerdict v;
    if (recordedHash == currentHash && !currentHash.empty()) {
        v.accepted = true;
        return v;
    }

    v.error = "replay wire-schema mismatch (recording " +
              ShortSchemaHash(recordedHash) + ", this build " +
              ShortSchemaHash(currentHash) +
              ") — the recorded messages would mis-decode against this "
              "binary's schema; replay it with the build that recorded it";
    if (recordedHash.empty()) {
        v.error += " (this recording predates the schema stamp, so no build "
                   "can be identified — it is not replayable)";
    }
    return v;
}

}  // namespace replay
