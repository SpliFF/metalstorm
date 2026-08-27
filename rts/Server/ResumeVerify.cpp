// ResumeVerify — see the header for what this is and why it exists.

#include "ResumeVerify.h"

#include <algorithm>

#include "SimSnapshot.h"

namespace resumeverify {

Verdict Compare(const std::vector<uint8_t>& applied,
                const std::vector<uint8_t>& recaptured) {
    Verdict v;
    v.appliedBytes = applied.size();
    v.recapturedBytes = recaptured.size();

    if (applied == recaptured) {
        v.identical = true;
        return v;
    }

    const size_t common = std::min(applied.size(), recaptured.size());
    const auto mm = std::mismatch(applied.begin(), applied.begin() + common,
                                  recaptured.begin());
    // Equal over the common prefix but different lengths: the first
    // difference is where the shorter one ends.
    const size_t off = static_cast<size_t>(mm.first - applied.begin());
    v.firstDifferentByte = static_cast<int64_t>(off);
    // Describe against the APPLIED payload — the reference the restore was
    // handed. DescribeOffset survives a payload the decoder would refuse and
    // says "past the end" for an offset beyond it, which is exactly the
    // prefix case.
    v.where = simsnapshot::DescribeOffset(applied.data(), applied.size(), off);
    v.sections = simsnapshot::DiffSections(applied, recaptured);
    return v;
}

std::string Format(const Verdict& v, int32_t frame) {
    if (v.identical) {
        return "resume verify: recapture IDENTICAL — " +
               std::to_string(v.appliedBytes) + " bytes at frame " +
               std::to_string(frame);
    }
    std::string s = "resume verify: recapture DIFFERS from the applied "
                    "snapshot at frame " + std::to_string(frame) + " — " +
                    std::to_string(v.appliedBytes) + " applied vs " +
                    std::to_string(v.recapturedBytes) +
                    " recaptured bytes, first difference at byte " +
                    std::to_string(v.firstDifferentByte) + " (" + v.where +
                    "); disagreeing sections:";
    if (v.sections.empty()) {
        // DiffSections found nothing nameable — a payload the walker could
        // not parse. Say so rather than printing an empty list that reads
        // like "no sections disagree".
        s += " (unparseable payload)";
    } else {
        for (size_t i = 0; i < v.sections.size(); ++i)
            s += (i == 0 ? " " : ", ") + v.sections[i];
    }
    return s;
}

}  // namespace resumeverify
