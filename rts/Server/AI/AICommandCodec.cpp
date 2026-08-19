#include "AICommandCodec.h"

#include <cstring>

/// Flatten one drained AICommand into the journal's opaque payload
/// (PLAN-replay task 1). AICommand is not trivially copyable — it carries
/// three heap fields — so it cannot be memcpy'd into a record. The encoding
/// is deliberately dumb and self-describing-by-position rather than a
/// flatbuffer: nothing but the replay driver ever reads it back, it must not
/// acquire a schema dependency, and every field is fixed-width or
/// length-prefixed so a decoder is a mirror of this function.
///
/// Ordering note: the CreateGroup→IssueDirective token correlation is resolved
/// *within* a drained batch, so `groupToken`/`refToken` are meaningless across
/// batches. They are recorded anyway — a replay re-pushes the whole batch in
/// the same order and re-resolves them the same way.
std::vector<uint8_t> SerializeAICommand(const AICommand& c) {
    std::vector<uint8_t> out;
    out.reserve(96);
    auto putU8  = [&](uint8_t v)  { out.push_back(v); };
    auto putU32 = [&](uint32_t v) {
        for (int i = 0; i < 4; ++i) out.push_back(static_cast<uint8_t>(v >> (8 * i)));
    };
    auto putI32 = [&](int32_t v)  { putU32(static_cast<uint32_t>(v)); };
    auto putF32 = [&](float v)    {
        uint32_t bits; std::memcpy(&bits, &v, 4); putU32(bits);
    };

    putU8(static_cast<uint8_t>(c.kind));
    putI32(c.teamId);
    putI32(c.playerId);
    // UnitCommand fields
    putU32(c.unitId);
    putI32(c.commandId);
    putU8(c.options);
    const int nParams = (c.numParams < 0) ? 0
                      : (c.numParams > 8) ? 8 : c.numParams;
    putU8(static_cast<uint8_t>(nParams));
    for (int i = 0; i < nParams; ++i) putF32(c.params[i]);
    // Directive-shaped fields
    putU8(c.echelon);
    putU32(static_cast<uint32_t>(c.squadIds.size()));
    for (uint32_t id : c.squadIds) putU32(id);
    putU32(c.groupToken);
    putU32(c.groupId);
    putU32(c.refToken);
    putU8(c.directiveType);
    putU8(c.priority);
    putU8(c.shape);
    putU32(static_cast<uint32_t>(c.directiveParams.size()));
    for (float f : c.directiveParams) putF32(f);
    putU32(c.requestedStrength);
    putU32(c.expiresInFrames);
    putF32(c.withinX);
    putF32(c.withinZ);
    putF32(c.withinRadius);
    putU32(static_cast<uint32_t>(c.text.size()));
    out.insert(out.end(), c.text.begin(), c.text.end());
    return out;
}

/// Exact mirror of SerializeAICommand — the replay side of chokepoint #4
/// (PLAN-replay task 2). Returns false on any short/garbled buffer rather than
/// producing a partly-filled command: a replay that applied half an AI order
/// would diverge silently, which is the one outcome worse than stopping.
///
/// Kept adjacent to the encoder on purpose. The two functions are a matched
/// pair and the only guard against them drifting apart is that a reader edits
/// them together; a round-trip doctest lives in tests/test_replay_file.cpp for
/// the framing, but the field list itself is enforced by proximity.
bool DeserializeAICommand(const std::vector<uint8_t>& in, AICommand& out) {
    size_t p = 0;
    bool ok = true;
    auto getU8 = [&](uint8_t& v) {
        if (p + 1 > in.size()) { ok = false; return; }
        v = in[p++];
    };
    auto getU32 = [&](uint32_t& v) {
        if (p + 4 > in.size()) { ok = false; return; }
        v = 0;
        for (int i = 0; i < 4; ++i) v |= static_cast<uint32_t>(in[p + i]) << (8 * i);
        p += 4;
    };
    auto getI32 = [&](int& v) {
        uint32_t u = 0; getU32(u); v = static_cast<int32_t>(u);
    };
    auto getF32 = [&](float& v) {
        uint32_t u = 0; getU32(u);
        if (ok) std::memcpy(&v, &u, 4);
    };

    AICommand c;
    uint8_t kind = 0;
    getU8(kind);
    c.kind = static_cast<AICommandKind>(kind);
    getI32(c.teamId);
    getI32(c.playerId);
    getU32(c.unitId);
    getI32(c.commandId);
    getU8(c.options);
    uint8_t nParams = 0;
    getU8(nParams);
    if (!ok || nParams > 8) return false;
    c.numParams = nParams;
    for (int i = 0; i < nParams; ++i) getF32(c.params[i]);

    getU8(c.echelon);
    uint32_t nSquads = 0;
    getU32(nSquads);
    if (!ok || nSquads > in.size()) return false;   // length sanity, not a real bound
    c.squadIds.resize(nSquads);
    for (uint32_t i = 0; i < nSquads; ++i) getU32(c.squadIds[i]);
    getU32(c.groupToken);
    getU32(c.groupId);
    getU32(c.refToken);
    getU8(c.directiveType);
    getU8(c.priority);
    getU8(c.shape);
    uint32_t nDirParams = 0;
    getU32(nDirParams);
    if (!ok || nDirParams > in.size()) return false;
    c.directiveParams.resize(nDirParams);
    for (uint32_t i = 0; i < nDirParams; ++i) getF32(c.directiveParams[i]);
    getU32(c.requestedStrength);
    getU32(c.expiresInFrames);
    getF32(c.withinX);
    getF32(c.withinZ);
    getF32(c.withinRadius);
    uint32_t textLen = 0;
    getU32(textLen);
    if (!ok || p + textLen > in.size()) return false;
    c.text.assign(in.begin() + static_cast<long>(p),
                  in.begin() + static_cast<long>(p + textLen));
    p += textLen;

    if (!ok) return false;
    out = std::move(c);
    return true;
}
