// ResumeVerify — the fresh-process half of snapshot idempotence
// (PLAN-persistence §8's re-capture bar, taken across a REAL process boundary).
//
// `--snapshot-roundtrip` asserts capture→apply→re-capture idempotence inside
// ONE process, and the wind defect (§8, 2026-08-12) is the record of why that
// arm structurally understates a resume: state the capture misses is
// INHERITED live by a same-process restore, so the re-capture agrees by
// accident — only a fresh process shows the missed state re-initialised.
// The three restore defects the re-capture bar has caught so far (the RNG
// advanced by the restore itself, ApplyTeams run before the roster rebuild,
// CBuilding::ForcedMove re-snapping every building) all surfaced as "the
// re-capture differs from the checkpoint it just applied", which is why the
// comparison — not tick tracking — is the proven instrument.
//
// This module is the comparison behind `--resume-verify`: a resumed boot
// re-captures the world immediately after applying it — before the first
// tick, before AI seats respawn, before any client can connect — and
// byte-compares the re-capture with the payload the resume applied. Identical
// bytes are §2's promise ("everything the walk claims to capture, it
// restores") made by the same process shape a real hibernate/resume uses.
//
// PURE: two byte vectors in, a verdict out. server_main owns the capture and
// the exit; tools/scripts/hibernate-resume-recapture.sh drives the whole
// cycle (run → SIGTERM exit checkpoint → relaunch `--resume --resume-verify`)
// and greps the sentinel Format() prints. The exit CODE is deliberately not
// the harness's gate — a debug build aborts in static destructors on every
// exit (PLAN-replay T5-c) — the log line is.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace resumeverify {

struct Verdict {
    bool identical = false;
    size_t appliedBytes = 0;
    size_t recapturedBytes = 0;
    /// First byte at which the two payloads disagree; -1 iff identical.
    /// When one payload is a clean prefix of the other this is the shorter
    /// length — "past the end" of the shorter side, and `where` says so.
    int64_t firstDifferentByte = -1;
    /// The section+offset phrase for that byte (simsnapshot::DescribeOffset
    /// over the APPLIED payload — the reference the restore was given).
    std::string where;
    /// Every disagreeing section, by name, in table order
    /// (simsnapshot::DiffSections). "the whole world differs" and "only the
    /// RNG position differs" are different defects.
    std::vector<std::string> sections;
};

/// Compare the payload a resume applied with the payload re-captured from the
/// world it produced. Byte equality is the bar: both vectors came out of the
/// same Serialize() shape, so any difference is a captured field the apply
/// did not restore, or restored and then let boot staging clobber.
Verdict Compare(const std::vector<uint8_t>& applied,
                const std::vector<uint8_t>& recaptured);

/// One log line. Contains exactly "resume verify: recapture IDENTICAL" on a
/// pass and "resume verify: recapture DIFFERS" otherwise — the harness greps
/// these phrases, so a wording change must move
/// tools/scripts/hibernate-resume-recapture.sh in the same commit.
std::string Format(const Verdict& v, int32_t frame);

}  // namespace resumeverify
