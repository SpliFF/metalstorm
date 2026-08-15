// Chat — the one chat service in the lobby process (PLAN-lobby.md §3).
//
// Task 9b. §3's design principle is "one chat service, reached over the
// existing POST + SSE pattern", so that the lobby, a room and an in-game
// panel are three views of the same store rather than three protocols. This
// file is the store and the rules; who may READ a scope is resolved by the
// route, which is the only layer that holds the room roster.
//
// ── A scope is (scope, target), and the target is CANONICAL ────────────────
// Every message is filed under a scope kind plus a target string, and the
// target is always computed by the server from what the sender asked for —
// never stored as the sender typed it. A PM between accounts 4 and 9 is
// `4:9` from both ends, so the two players are provably reading one
// conversation instead of two mailboxes that agree by convention. Same for
// ally chat: the sender names a room, and the server appends the team it
// reads off the roster, because a client that could name its own team could
// name somebody else's.
//
// ── Ignore is enforced on DELIVERY, not on render ──────────────────────────
// §3.4 says "filtered server-side on delivery (classic protocol parity)", and
// both halves are here: FilterIgnored drops recipients from a live fan-out,
// and History drops the same senders from the backfill. A client-side filter
// would be a filter the sender can measure — you can tell you are ignored by
// timing — and it puts the text on the ignorer's machine anyway.
//
// ── Flood control is a value type, not a service ───────────────────────────
// ChatFlood holds no database and no clock: it is told the time. §3.4's
// "flood = drop + warn, repeat = timed mute" is a state machine that is worth
// testing at second boundaries, and a rate limiter that reads the clock
// itself can only be tested by sleeping.
//
// ── Moderation is a STORE, not a connection state (task 9c) ────────────────
// §3.4's roles half lives at the bottom of this file. The distinction that
// decides its shape: ChatFlood's mute is a rate-limiter state and is
// process-local on purpose, so a flooder who reconnects gets a clean bucket;
// a moderator's mute is a *decision about an account* and must outlive the
// connection, the lobby process and the account's next login, or it is a
// suggestion. Same word, two mechanisms, and only one of them is a table.
//
// ── What is deliberately NOT here ──────────────────────────────────────────
// Every §3.5 quality-of-life item, and §4.6's `!` room-command surface, which
// is gated on §4's endpoints rather than on chat (see PLAN-lobby.md §3's
// status block for the census of which of its eleven verbs have one).
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

struct sqlite3;

// ── Scopes ─────────────────────────────────────────────────────────────────

/// §3.1's scope table. The kind decides who the recipients ARE; the target
/// decides which conversation within that kind.
enum class ChatScope {
    Main,       ///< `#main`, everyone online. Target is always "main".
    Channel,    ///< a named opt-in channel. Target is the normalised name.
    Room,       ///< a room/war channel. Target is the room id as text.
    Ally,       ///< one team inside a room. Target is `<roomId>/ally/<team>`.
    Spectator,  ///< a room's spectators. Target is `<roomId>/spec`.
    Pm,         ///< two accounts. Target is `<lowId>:<highId>`.
};

const char* ChatScopeToString(ChatScope s);

/// Parse a wire scope word. Returns false for anything unrecognised — a
/// mistyped scope must be a 400, never a silent fallback to `#main`, which is
/// the one scope where a misfile is broadcast to everybody online.
bool ChatScopeFromString(const std::string& s, ChatScope& out);

/// One stored line.
struct ChatMessage {
    int64_t     id = 0;
    ChatScope   scope = ChatScope::Main;
    std::string target;
    int64_t     fromId = 0;
    /// The sender's username as it was AT SEND TIME. Denormalised on purpose,
    /// against the rule Friends.h states for the social graph: a friend row
    /// describes a live relationship and must re-read the name, but a chat
    /// line is a record of something somebody said, and re-labelling five
    /// thousand old lines because an account was renamed (task 8c's guest
    /// upgrade) rewrites history rather than correcting it.
    std::string fromName;
    std::string text;
    int64_t     ts = 0;
    /// Server-generated line (joins/leaves, option changes, game start/end —
    /// §3.1's "carries system lines"). `fromId` is 0 for these.
    bool        system = false;
};

/// One moderator decision (§3.4: "timed/permanent mutes stored on the
/// account"). Durable, unlike ChatFlood's — see the header block.
struct ChatMute {
    int64_t     accountId = 0;
    /// Chat::GlobalMuteKey() (empty) for an account-level mute, otherwise the
    /// one conversation it applies to.
    std::string scopeKey;
    /// Unix seconds, or **0 meaning until lifted**. Deliberately not
    /// "0 = no mute": the ROW is the mute, so its absence is the only way to
    /// say "not muted" and 0 is free to mean the open-ended case.
    int64_t     until = 0;
    std::string reason;
    /// Who did it. Kept alongside the audit row rather than instead of it:
    /// the audit log is the operator's record, this is what the muted player
    /// is told, and a player must not be shown "you were muted" with nobody's
    /// name on it.
    int64_t     byId = 0;
    std::string byName;
    int64_t     createdAt = 0;

    bool Permanent() const { return until == 0; }
};

// ── Retention (§3.3) ───────────────────────────────────────────────────────

/// `#main` is a ring buffer: it is ambient noise with no history worth
/// paging, and it is the highest-volume scope in the process.
inline constexpr int kMainRingBuffer = 500;
/// Named channels keep a month. Long enough that "what was said in #help last
/// week" is answerable, short enough to bound an unmoderated table.
inline constexpr int64_t kNamedChannelRetentionSec = 30 * 24 * 60 * 60;
/// Room channels die with their room (Chat::DeleteRoom), so their retention
/// is not a clock. This is the backstop for rows whose room vanished without
/// one — a lobby that was killed mid-room leaves them behind.
inline constexpr int64_t kOrphanRoomRetentionSec = 7 * 24 * 60 * 60;

/// Longest single message. Chosen against the classic protocol's line-based
/// framing rather than a storage limit.
inline constexpr size_t kChatMaxTextBytes = 512;

class Chat {
public:
    /// Create the tables if absent. Additive only — same discipline as
    /// Friends::EnsureTable: this is the only copy of the history.
    static void EnsureTables(sqlite3* db);

    // ── Canonical targets ──
    // Each of these is the ONLY way its scope's target string is built. A
    // route that formats one by hand is a second spelling of the same
    // conversation, and the two halves silently stop being one channel.

    static std::string MainTarget();
    /// Lower-cased, `[a-z0-9_-]` only, 1..24 chars; empty means "not a legal
    /// channel name" and the caller answers 400. `#` is accepted and stripped
    /// so a client may send either spelling.
    static std::string NormalizeChannel(const std::string& name);
    static std::string RoomTarget(uint32_t roomId);
    static std::string AllyTarget(uint32_t roomId, int team);
    static std::string SpectatorTarget(uint32_t roomId);
    /// Order-independent: PmTarget(a,b) == PmTarget(b,a).
    static std::string PmTarget(int64_t a, int64_t b);
    /// The two account ids in a PM target, or {0,0} if it is not one. Lets a
    /// delivery path derive the recipients from the target it just built
    /// rather than carrying them alongside it.
    static std::pair<int64_t, int64_t> PmParticipants(const std::string& target);

    // ── Text ──

    /// Trim, reject empty/oversize, and strip control characters (which would
    /// otherwise let a sender inject SSE frame separators — a `\n\n` in a
    /// message body ends the event). Returns false with `err` set.
    ///
    /// This is NOT HTML escaping: the store keeps what was typed and the
    /// renderer escapes it (the existing XSS rule, §3.4). Escaping here would
    /// double-escape the moment a second consumer appeared.
    static bool ValidateText(const std::string& in, std::string& out, std::string& err);

    // ── Store ──

    /// Append one line. Returns its rowid, or 0 on failure.
    static int64_t Append(sqlite3* db, ChatScope scope, const std::string& target,
                          int64_t fromId, const std::string& fromName,
                          const std::string& text, int64_t ts, bool system = false);

    /// Newest-first page of a conversation, excluding senders `viewerId`
    /// ignores. `beforeId` of 0 means "from the newest"; otherwise only rows
    /// with a lower id are returned, which is what makes paging stable while
    /// people keep talking.
    static std::vector<ChatMessage> History(sqlite3* db, ChatScope scope,
                                            const std::string& target,
                                            int64_t viewerId, int64_t beforeId,
                                            int limit);

    /// Drop a room's channels (room, every ally team, spectators) — called
    /// when the room is deleted. §3.3 says room channels are "deleted with the
    /// room (after being archived to the game record for replay context)";
    /// the archive half belongs to the game-record writer and is not yet
    /// wired, which is why this is a separate call rather than a DB trigger.
    static int DeleteRoom(sqlite3* db, uint32_t roomId);

    /// Apply §3.3's retention rules, plus the served-mute sweep. Cheap enough
    /// for the maintenance tick. Returns rows deleted across both tables.
    static int Prune(sqlite3* db, int64_t now);

    // ── Ignore list (§3.4) ──

    static bool SetIgnore(sqlite3* db, int64_t viewerId, int64_t targetId, bool on);
    static bool IsIgnored(sqlite3* db, int64_t viewerId, int64_t senderId);
    static std::vector<int64_t> IgnoreList(sqlite3* db, int64_t viewerId);

    /// The subset of `recipients` that has NOT ignored `senderId`, order
    /// preserved. One query for the whole fan-out — the alternative is an
    /// IsIgnored call per recipient per message, on the lobby's single DB
    /// handle, at chat rates.
    static std::vector<int64_t> FilterIgnored(sqlite3* db, int64_t senderId,
                                              const std::vector<int64_t>& recipients);

    // ── Moderator mutes (§3.4's roles half) ──

    /// The scope key an account-level mute is filed under. Empty string, and
    /// it is a named constant because "" is also what a caller passes by
    /// accident: every route builds the key through MuteKey() or through
    /// this, so a typo'd scope cannot silently become a global silence.
    static std::string GlobalMuteKey();
    /// The key for one conversation. Always built from a CANONICAL target —
    /// the same string History pages on — so a mute cannot be evaded by
    /// spelling the target differently.
    static std::string MuteKey(ChatScope scope, const std::string& target);
    /// The scope word inside a key, or "" for the global key. Lets the
    /// moderation policy read a key without a second parameter carrying the
    /// same fact.
    static std::string MuteKeyScope(const std::string& key);

    /// Write or replace a mute. `m.until` of 0 means "until lifted".
    static bool SetMute(sqlite3* db, const ChatMute& m);
    /// Lift one. Returns true if a row went away — an unmute that matched
    /// nothing is reported rather than answered "ok", because the usual cause
    /// is a moderator lifting a mute in the wrong scope.
    static bool ClearMute(sqlite3* db, int64_t accountId, const std::string& scopeKey);
    /// The mute in force for this account in this conversation, if any: the
    /// account-level row FIRST, then the conversation's own. An expired row is
    /// not in force and is never returned (Prune deletes it later — expiry is
    /// a property of the row, not of the sweep having run).
    static std::optional<ChatMute> ActiveMute(sqlite3* db, int64_t accountId,
                                              const std::string& scopeKey, int64_t now);
    /// The conversation's OWN row only, ignoring any account-level mute.
    /// Exists for the one question that is about *hearing* rather than
    /// speaking — whether a kicked player may re-enter a channel. An
    /// account-level mute silences a player everywhere; it does not blind
    /// them, and answering that question with ActiveMute would quietly turn
    /// every global mute into a ban from every named channel.
    static std::optional<ChatMute> ScopedMute(sqlite3* db, int64_t accountId,
                                              const std::string& scopeKey, int64_t now);
    /// Every mute in force, newest first. The moderator's read path.
    static std::vector<ChatMute> Mutes(sqlite3* db, int64_t now);
};

// ── Channel membership ─────────────────────────────────────────────────────

/// Who is listening to `#main` and the named channels, in this process.
///
/// Deliberately NOT a table. Every other scope's membership is a fact
/// somebody else already owns — a room's roster is the room's, a PM's is the
/// two account ids in its target — and a named channel's is a property of a
/// live connection: you are in `#help` while your client is there. Persisting
/// it would mean an account that joined `#dev` once is a recipient forever,
/// and every fan-out would carry a list of people who are not connected.
///
/// Bounded by connected accounts and dropped when they leave.
class ChatChannels {
public:
    void Join(int64_t accountId, const std::string& channel);
    void Leave(int64_t accountId, const std::string& channel);
    /// Every channel, for a client that has gone away.
    void LeaveAll(int64_t accountId);
    bool IsMember(int64_t accountId, const std::string& channel) const;
    /// Recipients for a fan-out, ordered by account id so a delivery list is
    /// reproducible in a test.
    std::vector<int64_t> Members(const std::string& channel) const;
    std::vector<std::string> ChannelsFor(int64_t accountId) const;

private:
    /// channel → members. Small: the count of *named* channels a deployment
    /// runs, plus `#main`.
    std::unordered_map<std::string, std::vector<int64_t>> members_;
};

// ── Flood control (§3.4) ───────────────────────────────────────────────────

/// "Rate limit 1 msg/sec burst 4 (token bucket); flood = drop + warn, repeat
/// = timed mute."
enum class ChatSendVerdict {
    Allow,
    Dropped,  ///< over budget: the message is dropped and the sender warned
    Muted,    ///< kept flooding through the warnings: silenced until a time
};

/// Refill rate and ceiling. One token per second, four in hand.
inline constexpr double kChatTokensPerSec = 1.0;
inline constexpr double kChatBurstTokens = 4.0;
/// How long a channel kick keeps the kicked account out (§3.4's "channel ops
/// (mute/kick from channel)"). A kick is a cooling-off, not a ban: an
/// indefinite one is what the mute verb is for, and a kick that expires by
/// itself is the one a moderator does not have to remember to undo.
inline constexpr int64_t kChatKickMuteSec = 300;

/// Consecutive drops that turn a warning into a mute, and how long for.
inline constexpr int kChatDropsBeforeMute = 5;
inline constexpr int64_t kChatMuteSec = 60;

// ── Who may moderate (§3.4's roles half) ───────────────────────────────────

/// The actor's standing for ONE moderation request. `RoomHost` is a fact
/// about a specific room, so a caller may only pass it for a scope key
/// belonging to *that* room — the policy below cannot check it, because the
/// roster lives in RoomManager and this file deliberately holds no rooms.
enum class ChatRole {
    Player,
    RoomHost,  ///< host of the room whose channel is being moderated
    Admin,     ///< the account-level "admin" role
};

enum class ChatModerationRight {
    Allowed,
    NotAnOp,        ///< the actor holds no ops in this scope
    ImmuneSubject,  ///< the subject is an admin
    SelfTarget,     ///< the actor named themselves
};

/// §3.4's role map, as a pure function of the request. Every rule that
/// decides it is here rather than spread across four routes:
///
///  * **an admin is never muted by a chat row.** An admin who is abusing
///    chat is a role problem, and a mute that a moderator can apply to the
///    person who can lift it is a fight, not a moderation system.
///  * **a room host is an op in their OWN room's three channels** (room,
///    ally, spectator) and nowhere else. §3.1 makes the room channel the
///    room's, and the host is the only role a room has; a host who could mute
///    globally would be a moderator by opening a room.
///  * **`#main` and named channels are the server's**, so only an admin ops
///    them. §3.1 makes named channels admin-creatable first, and there is no
///    channel-owner concept to inherit ops from.
///  * **nobody moderates themselves** — representable, meaningless, and it
///    is how a moderator locks themselves out of the channel they run.
ChatModerationRight ChatCanModerate(const std::string& scopeKey, ChatRole actor,
                                    bool subjectIsAdmin, bool selfTarget);

/// Human-readable refusal, so four routes cannot word the same rule three
/// ways.
const char* ChatModerationRightToString(ChatModerationRight r);

/// Per-account token bucket. Process-local by design: chat rates are a
/// property of a live connection, and persisting them would mean a flooder
/// gets a clean bucket by reconnecting only if we forgot to.
///
/// Told the time; see the header block.
class ChatFlood {
public:
    /// `now` is a monotonic-ish wall clock in SECONDS as a double, so the
    /// sub-second refill that makes a token bucket a bucket is representable.
    ChatSendVerdict Check(int64_t accountId, double now);

    /// When `accountId`'s mute expires (0 = not muted). For the 429 body, so
    /// a client can say how long rather than "try again".
    int64_t MutedUntil(int64_t accountId) const;

    /// Drop state for accounts that have been quiet longer than a mute could
    /// last. Called from the same maintenance tick as Chat::Prune.
    void Prune(double now);

    /// Testing/administrative reset.
    void Clear() { buckets_.clear(); }

private:
    struct Bucket {
        double tokens = kChatBurstTokens;
        double last = 0;
        int consecutiveDrops = 0;
        int64_t mutedUntil = 0;
    };
    std::unordered_map<int64_t, Bucket> buckets_;
};
