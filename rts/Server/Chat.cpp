#include "Chat.h"

#include <sqlite3.h>

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <utility>

namespace {

int ExecCounting(sqlite3* db, const char* sql) {
    if (sqlite3_exec(db, sql, nullptr, nullptr, nullptr) != SQLITE_OK) return 0;
    return sqlite3_changes(db);
}

void BindText(sqlite3_stmt* s, int i, const std::string& v) {
    sqlite3_bind_text(s, i, v.c_str(), (int)v.size(), SQLITE_TRANSIENT);
}

std::string ColText(sqlite3_stmt* s, int i) {
    const unsigned char* p = sqlite3_column_text(s, i);
    return p ? reinterpret_cast<const char*>(p) : "";
}

}  // namespace

const char* ChatScopeToString(ChatScope s) {
    switch (s) {
        case ChatScope::Main:      return "main";
        case ChatScope::Channel:   return "channel";
        case ChatScope::Room:      return "room";
        case ChatScope::Ally:      return "ally";
        case ChatScope::Spectator: return "spectator";
        case ChatScope::Pm:        return "pm";
    }
    return "main";
}

bool ChatScopeFromString(const std::string& s, ChatScope& out) {
    if (s == "main")      { out = ChatScope::Main;      return true; }
    if (s == "channel")   { out = ChatScope::Channel;   return true; }
    if (s == "room")      { out = ChatScope::Room;      return true; }
    if (s == "ally")      { out = ChatScope::Ally;      return true; }
    if (s == "spectator") { out = ChatScope::Spectator; return true; }
    if (s == "pm")        { out = ChatScope::Pm;        return true; }
    return false;
}

// ── Schema ─────────────────────────────────────────────────────────────────

void Chat::EnsureTables(sqlite3* db) {
    if (!db) return;
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS chat_messages ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  scope TEXT NOT NULL,"
        "  target TEXT NOT NULL,"
        "  from_id INTEGER NOT NULL DEFAULT 0,"
        "  from_name TEXT NOT NULL DEFAULT '',"
        "  text TEXT NOT NULL,"
        "  ts INTEGER NOT NULL DEFAULT 0,"
        "  is_system INTEGER NOT NULL DEFAULT 0"
        ")", nullptr, nullptr, nullptr);
    // Every read is "this conversation, newest first" — History pages on id
    // DESC within (scope, target), and that is also the shape DeleteRoom and
    // Prune scan. A single composite index serves all three; the id tail is
    // what keeps the page ordered without a sort.
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_chat_messages_conv "
        "ON chat_messages(scope, target, id DESC)", nullptr, nullptr, nullptr);
    // Retention sweeps by age across scopes.
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_chat_messages_ts "
        "ON chat_messages(ts)", nullptr, nullptr, nullptr);

    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS chat_ignores ("
        "  viewer_id INTEGER NOT NULL,"
        "  target_id INTEGER NOT NULL,"
        "  created_at INTEGER NOT NULL DEFAULT 0,"
        "  PRIMARY KEY (viewer_id, target_id)"
        ")", nullptr, nullptr, nullptr);

    // Moderator mutes (§3.4). The primary key is (account, scope) so that a
    // second mute in the same scope REPLACES the first — a moderator
    // extending a mute must not leave two rows whose disagreement is settled
    // by whichever the reader saw first.
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS chat_mutes ("
        "  account_id INTEGER NOT NULL,"
        "  scope_key TEXT NOT NULL DEFAULT '',"
        "  until INTEGER NOT NULL DEFAULT 0,"
        "  reason TEXT NOT NULL DEFAULT '',"
        "  by_id INTEGER NOT NULL DEFAULT 0,"
        "  by_name TEXT NOT NULL DEFAULT '',"
        "  created_at INTEGER NOT NULL DEFAULT 0,"
        "  PRIMARY KEY (account_id, scope_key)"
        ")", nullptr, nullptr, nullptr);
}

// ── Canonical targets ──────────────────────────────────────────────────────

std::string Chat::MainTarget() { return "main"; }

std::string Chat::NormalizeChannel(const std::string& name) {
    std::string s = name;
    if (!s.empty() && s[0] == '#') s.erase(s.begin());
    if (s.empty() || s.size() > 24) return "";
    std::string out;
    out.reserve(s.size());
    for (unsigned char c : s) {
        const unsigned char lc = (unsigned char)std::tolower(c);
        const bool ok = (lc >= 'a' && lc <= 'z') || (lc >= '0' && lc <= '9') ||
                        lc == '_' || lc == '-';
        if (!ok) return "";  // reject, never sanitise: `#help!` and `#help`
                             // must not be the same room by accident.
        out.push_back((char)lc);
    }
    return out;
}

std::string Chat::RoomTarget(uint32_t roomId) {
    return std::to_string(roomId);
}

std::string Chat::AllyTarget(uint32_t roomId, int team) {
    return std::to_string(roomId) + "/ally/" + std::to_string(team);
}

std::string Chat::SpectatorTarget(uint32_t roomId) {
    return std::to_string(roomId) + "/spec";
}

std::string Chat::PmTarget(int64_t a, int64_t b) {
    const int64_t lo = std::min(a, b);
    const int64_t hi = std::max(a, b);
    return std::to_string(lo) + ":" + std::to_string(hi);
}

std::pair<int64_t, int64_t> Chat::PmParticipants(const std::string& target) {
    const auto colon = target.find(':');
    if (colon == std::string::npos) return {0, 0};
    const int64_t lo = std::strtoll(target.substr(0, colon).c_str(), nullptr, 10);
    const int64_t hi = std::strtoll(target.substr(colon + 1).c_str(), nullptr, 10);
    if (lo <= 0 || hi <= 0) return {0, 0};
    return {lo, hi};
}

// ── Text ───────────────────────────────────────────────────────────────────

bool Chat::ValidateText(const std::string& in, std::string& out, std::string& err) {
    std::string s;
    s.reserve(in.size());
    for (unsigned char c : in) {
        // Control characters go, including the newlines that would end an SSE
        // event mid-message and let a sender forge a second frame. Bytes with
        // the high bit set are UTF-8 continuation/lead bytes and are kept.
        if (c < 0x20 || c == 0x7f) continue;
        s.push_back((char)c);
    }
    const auto first = s.find_first_not_of(' ');
    const auto last = s.find_last_not_of(' ');
    s = (first == std::string::npos) ? "" : s.substr(first, last - first + 1);
    if (s.empty()) {
        err = "empty message";
        return false;
    }
    if (s.size() > kChatMaxTextBytes) {
        err = "message too long";
        return false;
    }
    out = std::move(s);
    return true;
}

// ── Store ──────────────────────────────────────────────────────────────────

int64_t Chat::Append(sqlite3* db, ChatScope scope, const std::string& target,
                     int64_t fromId, const std::string& fromName,
                     const std::string& text, int64_t ts, bool system) {
    if (!db || target.empty() || text.empty()) return 0;
    static const char* kSql =
        "INSERT INTO chat_messages (scope, target, from_id, from_name, text, ts, is_system) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)";
    sqlite3_stmt* s = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &s, nullptr) != SQLITE_OK) {
        sqlite3_finalize(s);
        return 0;
    }
    sqlite3_bind_text(s, 1, ChatScopeToString(scope), -1, SQLITE_STATIC);
    BindText(s, 2, target);
    sqlite3_bind_int64(s, 3, fromId);
    BindText(s, 4, fromName);
    BindText(s, 5, text);
    sqlite3_bind_int64(s, 6, ts);
    sqlite3_bind_int(s, 7, system ? 1 : 0);
    const bool ok = sqlite3_step(s) == SQLITE_DONE;
    sqlite3_finalize(s);
    return ok ? sqlite3_last_insert_rowid(db) : 0;
}

std::vector<ChatMessage> Chat::History(sqlite3* db, ChatScope scope,
                                       const std::string& target, int64_t viewerId,
                                       int64_t beforeId, int limit) {
    std::vector<ChatMessage> out;
    if (!db || target.empty()) return out;
    if (limit <= 0 || limit > 200) limit = 50;
    // The ignore filter is the same rule FilterIgnored applies to live
    // delivery — an ignored sender must not arrive by the back door of a
    // reconnect. System lines (from_id 0) are never ignorable: they are the
    // channel telling you what happened to it.
    static const char* kSql =
        "SELECT id, scope, target, from_id, from_name, text, ts, is_system "
        "FROM chat_messages "
        "WHERE scope=? AND target=? AND (?=0 OR id<?) "
        "  AND (from_id=0 OR from_id NOT IN "
        "       (SELECT target_id FROM chat_ignores WHERE viewer_id=?)) "
        "ORDER BY id DESC LIMIT ?";
    sqlite3_stmt* s = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &s, nullptr) != SQLITE_OK) {
        sqlite3_finalize(s);
        return out;
    }
    sqlite3_bind_text(s, 1, ChatScopeToString(scope), -1, SQLITE_STATIC);
    BindText(s, 2, target);
    sqlite3_bind_int64(s, 3, beforeId);
    sqlite3_bind_int64(s, 4, beforeId);
    sqlite3_bind_int64(s, 5, viewerId);
    sqlite3_bind_int(s, 6, limit);
    while (sqlite3_step(s) == SQLITE_ROW) {
        ChatMessage m;
        m.id = sqlite3_column_int64(s, 0);
        ChatScopeFromString(ColText(s, 1), m.scope);
        m.target = ColText(s, 2);
        m.fromId = sqlite3_column_int64(s, 3);
        m.fromName = ColText(s, 4);
        m.text = ColText(s, 5);
        m.ts = sqlite3_column_int64(s, 6);
        m.system = sqlite3_column_int(s, 7) != 0;
        out.push_back(std::move(m));
    }
    sqlite3_finalize(s);
    return out;
}

int Chat::DeleteRoom(sqlite3* db, uint32_t roomId) {
    if (!db) return 0;
    // All three room-shaped scopes at once. The ally/spectator targets are
    // PREFIXED with the room id (`<id>/ally/<team>`), so they are matched on
    // the prefix rather than enumerated — a room whose teams were never known
    // to this call still loses its team channels.
    static const char* kSql =
        "DELETE FROM chat_messages WHERE "
        "  (scope='room' AND target=?) OR "
        "  (scope IN ('ally','spectator') AND (target=? OR target LIKE ?))";
    sqlite3_stmt* s = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &s, nullptr) != SQLITE_OK) {
        sqlite3_finalize(s);
        return 0;
    }
    const std::string id = std::to_string(roomId);
    BindText(s, 1, id);
    BindText(s, 2, id);
    BindText(s, 3, id + "/%");
    sqlite3_step(s);
    sqlite3_finalize(s);
    return sqlite3_changes(db);
}

int Chat::Prune(sqlite3* db, int64_t now) {
    if (!db) return 0;
    int deleted = 0;

    // `#main` — ring buffer. Keeping the newest N by id rather than by age:
    // a quiet week must not empty the channel, and a busy hour must not
    // outgrow it.
    {
        const std::string sql =
            "DELETE FROM chat_messages WHERE scope='main' AND id <= "
            "(SELECT COALESCE(MIN(id),0) FROM (SELECT id FROM chat_messages "
            " WHERE scope='main' ORDER BY id DESC LIMIT " +
            std::to_string(kMainRingBuffer) + ")) - 1";
        deleted += ExecCounting(db, sql.c_str());
    }
    // Named channels — by age.
    {
        const std::string sql =
            "DELETE FROM chat_messages WHERE scope='channel' AND ts < " +
            std::to_string(now - kNamedChannelRetentionSec);
        deleted += ExecCounting(db, sql.c_str());
    }
    // Room-shaped scopes — DeleteRoom is the real reaper; this only clears
    // rows whose room went away without one.
    {
        const std::string sql =
            "DELETE FROM chat_messages WHERE scope IN ('room','ally','spectator') "
            "AND ts < " + std::to_string(now - kOrphanRoomRetentionSec);
        deleted += ExecCounting(db, sql.c_str());
    }
    // Served mutes. ActiveMute already ignores an expired row, so this is
    // hygiene rather than enforcement — deliberately, because a sweep that
    // has not run must never be the reason somebody can speak again.
    {
        const std::string sql =
            "DELETE FROM chat_mutes WHERE until>0 AND until<=" + std::to_string(now);
        deleted += ExecCounting(db, sql.c_str());
    }
    // PMs are not swept: §3.3 keeps them "until both parties delete", and no
    // delete verb exists yet. Stated so the absence reads as a decision.
    return deleted;
}

// ── Ignore list ────────────────────────────────────────────────────────────

bool Chat::SetIgnore(sqlite3* db, int64_t viewerId, int64_t targetId, bool on) {
    if (!db || viewerId <= 0 || targetId <= 0) return false;
    // Self-ignore is refused for the same reason Friends refuses a self-edge:
    // it is representable, meaningless, and every reader downstream would
    // have to remember that your own messages can be missing from your own
    // history.
    if (viewerId == targetId) return false;
    sqlite3_stmt* s = nullptr;
    const char* sql = on
        ? "INSERT INTO chat_ignores (viewer_id, target_id, created_at) "
          "VALUES (?, ?, strftime('%s','now')) ON CONFLICT DO NOTHING"
        : "DELETE FROM chat_ignores WHERE viewer_id=? AND target_id=?";
    if (sqlite3_prepare_v2(db, sql, -1, &s, nullptr) != SQLITE_OK) {
        sqlite3_finalize(s);
        return false;
    }
    sqlite3_bind_int64(s, 1, viewerId);
    sqlite3_bind_int64(s, 2, targetId);
    const bool ok = sqlite3_step(s) == SQLITE_DONE;
    sqlite3_finalize(s);
    return ok;
}

bool Chat::IsIgnored(sqlite3* db, int64_t viewerId, int64_t senderId) {
    if (!db || viewerId <= 0 || senderId <= 0) return false;
    sqlite3_stmt* s = nullptr;
    if (sqlite3_prepare_v2(db,
            "SELECT 1 FROM chat_ignores WHERE viewer_id=? AND target_id=?",
            -1, &s, nullptr) != SQLITE_OK) {
        sqlite3_finalize(s);
        return false;
    }
    sqlite3_bind_int64(s, 1, viewerId);
    sqlite3_bind_int64(s, 2, senderId);
    const bool found = sqlite3_step(s) == SQLITE_ROW;
    sqlite3_finalize(s);
    return found;
}

std::vector<int64_t> Chat::IgnoreList(sqlite3* db, int64_t viewerId) {
    std::vector<int64_t> out;
    if (!db || viewerId <= 0) return out;
    sqlite3_stmt* s = nullptr;
    if (sqlite3_prepare_v2(db,
            "SELECT target_id FROM chat_ignores WHERE viewer_id=? ORDER BY target_id",
            -1, &s, nullptr) != SQLITE_OK) {
        sqlite3_finalize(s);
        return out;
    }
    sqlite3_bind_int64(s, 1, viewerId);
    while (sqlite3_step(s) == SQLITE_ROW) out.push_back(sqlite3_column_int64(s, 0));
    sqlite3_finalize(s);
    return out;
}

std::vector<int64_t> Chat::FilterIgnored(sqlite3* db, int64_t senderId,
                                         const std::vector<int64_t>& recipients) {
    if (!db || senderId <= 0 || recipients.empty()) return recipients;
    // "Who, among everyone, has ignored this sender" is one query whose
    // result is usually empty; the fan-out is then a set lookup per
    // recipient. Asking per recipient instead is N queries on the lobby's
    // single write-locked handle for every line of chat.
    std::vector<int64_t> ignorers;
    sqlite3_stmt* s = nullptr;
    if (sqlite3_prepare_v2(db,
            "SELECT viewer_id FROM chat_ignores WHERE target_id=?",
            -1, &s, nullptr) != SQLITE_OK) {
        sqlite3_finalize(s);
        return recipients;
    }
    sqlite3_bind_int64(s, 1, senderId);
    while (sqlite3_step(s) == SQLITE_ROW) ignorers.push_back(sqlite3_column_int64(s, 0));
    sqlite3_finalize(s);
    if (ignorers.empty()) return recipients;

    std::vector<int64_t> out;
    out.reserve(recipients.size());
    for (int64_t r : recipients) {
        if (std::find(ignorers.begin(), ignorers.end(), r) == ignorers.end())
            out.push_back(r);
    }
    return out;
}

// ── Moderator mutes ────────────────────────────────────────────────────────

std::string Chat::GlobalMuteKey() { return ""; }

std::string Chat::MuteKey(ChatScope scope, const std::string& target) {
    return std::string(ChatScopeToString(scope)) + ":" + target;
}

std::string Chat::MuteKeyScope(const std::string& key) {
    const auto colon = key.find(':');
    if (colon == std::string::npos) return "";
    return key.substr(0, colon);
}

bool Chat::SetMute(sqlite3* db, const ChatMute& m) {
    if (!db || m.accountId <= 0) return false;
    static const char* kSql =
        "INSERT INTO chat_mutes "
        "  (account_id, scope_key, until, reason, by_id, by_name, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT (account_id, scope_key) DO UPDATE SET "
        "  until=excluded.until, reason=excluded.reason, by_id=excluded.by_id, "
        "  by_name=excluded.by_name, created_at=excluded.created_at";
    sqlite3_stmt* s = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &s, nullptr) != SQLITE_OK) {
        sqlite3_finalize(s);
        return false;
    }
    sqlite3_bind_int64(s, 1, m.accountId);
    BindText(s, 2, m.scopeKey);
    sqlite3_bind_int64(s, 3, m.until);
    BindText(s, 4, m.reason);
    sqlite3_bind_int64(s, 5, m.byId);
    BindText(s, 6, m.byName);
    sqlite3_bind_int64(s, 7, m.createdAt);
    const bool ok = sqlite3_step(s) == SQLITE_DONE;
    sqlite3_finalize(s);
    return ok;
}

bool Chat::ClearMute(sqlite3* db, int64_t accountId, const std::string& scopeKey) {
    if (!db || accountId <= 0) return false;
    sqlite3_stmt* s = nullptr;
    if (sqlite3_prepare_v2(db,
            "DELETE FROM chat_mutes WHERE account_id=? AND scope_key=?",
            -1, &s, nullptr) != SQLITE_OK) {
        sqlite3_finalize(s);
        return false;
    }
    sqlite3_bind_int64(s, 1, accountId);
    BindText(s, 2, scopeKey);
    sqlite3_step(s);
    sqlite3_finalize(s);
    return sqlite3_changes(db) > 0;
}

namespace {

ChatMute ReadMute(sqlite3_stmt* s) {
    ChatMute m;
    m.accountId = sqlite3_column_int64(s, 0);
    m.scopeKey = ColText(s, 1);
    m.until = sqlite3_column_int64(s, 2);
    m.reason = ColText(s, 3);
    m.byId = sqlite3_column_int64(s, 4);
    m.byName = ColText(s, 5);
    m.createdAt = sqlite3_column_int64(s, 6);
    return m;
}

const char* kMuteCols =
    "account_id, scope_key, until, reason, by_id, by_name, created_at";

}  // namespace

std::optional<ChatMute> Chat::ActiveMute(sqlite3* db, int64_t accountId,
                                         const std::string& scopeKey, int64_t now) {
    if (!db || accountId <= 0) return std::nullopt;
    // The account-level row wins the tie, and the ORDER BY is what makes that
    // true rather than the row order: a player muted everywhere AND in one
    // channel must be told the bigger of the two, or the mute they are shown
    // expires while they are still silent.
    const std::string sql =
        std::string("SELECT ") + kMuteCols +
        " FROM chat_mutes WHERE account_id=? AND (scope_key='' OR scope_key=?) "
        "  AND (until=0 OR until>?) "
        "ORDER BY (scope_key='') DESC LIMIT 1";
    sqlite3_stmt* s = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &s, nullptr) != SQLITE_OK) {
        sqlite3_finalize(s);
        return std::nullopt;
    }
    sqlite3_bind_int64(s, 1, accountId);
    BindText(s, 2, scopeKey);
    sqlite3_bind_int64(s, 3, now);
    std::optional<ChatMute> out;
    if (sqlite3_step(s) == SQLITE_ROW) out = ReadMute(s);
    sqlite3_finalize(s);
    return out;
}

std::optional<ChatMute> Chat::ScopedMute(sqlite3* db, int64_t accountId,
                                         const std::string& scopeKey, int64_t now) {
    if (!db || accountId <= 0 || scopeKey.empty()) return std::nullopt;
    const std::string sql =
        std::string("SELECT ") + kMuteCols +
        " FROM chat_mutes WHERE account_id=? AND scope_key=? AND (until=0 OR until>?)";
    sqlite3_stmt* s = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &s, nullptr) != SQLITE_OK) {
        sqlite3_finalize(s);
        return std::nullopt;
    }
    sqlite3_bind_int64(s, 1, accountId);
    BindText(s, 2, scopeKey);
    sqlite3_bind_int64(s, 3, now);
    std::optional<ChatMute> out;
    if (sqlite3_step(s) == SQLITE_ROW) out = ReadMute(s);
    sqlite3_finalize(s);
    return out;
}

std::vector<ChatMute> Chat::Mutes(sqlite3* db, int64_t now) {
    std::vector<ChatMute> out;
    if (!db) return out;
    const std::string sql =
        std::string("SELECT ") + kMuteCols +
        " FROM chat_mutes WHERE until=0 OR until>? ORDER BY created_at DESC, account_id";
    sqlite3_stmt* s = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &s, nullptr) != SQLITE_OK) {
        sqlite3_finalize(s);
        return out;
    }
    sqlite3_bind_int64(s, 1, now);
    while (sqlite3_step(s) == SQLITE_ROW) out.push_back(ReadMute(s));
    sqlite3_finalize(s);
    return out;
}

// ── Who may moderate ───────────────────────────────────────────────────────

ChatModerationRight ChatCanModerate(const std::string& scopeKey, ChatRole actor,
                                    bool subjectIsAdmin, bool selfTarget) {
    if (selfTarget) return ChatModerationRight::SelfTarget;
    // Checked before the actor's own standing so that an admin gets the same
    // answer as a host: this is a property of the SUBJECT, and an admin who
    // could mute another admin makes the rule depend on who moved first.
    if (subjectIsAdmin) return ChatModerationRight::ImmuneSubject;
    if (actor == ChatRole::Admin) return ChatModerationRight::Allowed;
    if (actor == ChatRole::RoomHost) {
        const std::string scope = Chat::MuteKeyScope(scopeKey);
        const bool roomShaped =
            scope == "room" || scope == "ally" || scope == "spectator";
        // A host's ops stop at their room's own channels. The GLOBAL key is
        // deliberately not room-shaped, so this also refuses the one request
        // that would turn opening a room into a moderator role.
        return roomShaped ? ChatModerationRight::Allowed
                          : ChatModerationRight::NotAnOp;
    }
    return ChatModerationRight::NotAnOp;
}

const char* ChatModerationRightToString(ChatModerationRight r) {
    switch (r) {
        case ChatModerationRight::Allowed:       return "allowed";
        case ChatModerationRight::NotAnOp:       return "you do not op that channel";
        case ChatModerationRight::ImmuneSubject: return "that account cannot be muted";
        case ChatModerationRight::SelfTarget:    return "you cannot moderate yourself";
    }
    return "refused";
}

// ── Channel membership ─────────────────────────────────────────────────────

void ChatChannels::Join(int64_t accountId, const std::string& channel) {
    if (accountId <= 0 || channel.empty()) return;
    auto& v = members_[channel];
    auto it = std::lower_bound(v.begin(), v.end(), accountId);
    if (it == v.end() || *it != accountId) v.insert(it, accountId);
}

void ChatChannels::Leave(int64_t accountId, const std::string& channel) {
    auto ch = members_.find(channel);
    if (ch == members_.end()) return;
    auto& v = ch->second;
    auto it = std::lower_bound(v.begin(), v.end(), accountId);
    if (it != v.end() && *it == accountId) v.erase(it);
    // An empty channel is not a channel: leaving the key behind would make
    // `#help` exist because somebody once visited it.
    if (v.empty()) members_.erase(ch);
}

void ChatChannels::LeaveAll(int64_t accountId) {
    for (auto it = members_.begin(); it != members_.end();) {
        auto& v = it->second;
        auto pos = std::lower_bound(v.begin(), v.end(), accountId);
        if (pos != v.end() && *pos == accountId) v.erase(pos);
        if (v.empty()) it = members_.erase(it);
        else ++it;
    }
}

bool ChatChannels::IsMember(int64_t accountId, const std::string& channel) const {
    auto ch = members_.find(channel);
    if (ch == members_.end()) return false;
    return std::binary_search(ch->second.begin(), ch->second.end(), accountId);
}

std::vector<int64_t> ChatChannels::Members(const std::string& channel) const {
    auto ch = members_.find(channel);
    return ch == members_.end() ? std::vector<int64_t>{} : ch->second;
}

std::vector<std::string> ChatChannels::ChannelsFor(int64_t accountId) const {
    std::vector<std::string> out;
    for (const auto& [name, v] : members_)
        if (std::binary_search(v.begin(), v.end(), accountId)) out.push_back(name);
    std::sort(out.begin(), out.end());
    return out;
}

// ── Flood control ──────────────────────────────────────────────────────────

ChatSendVerdict ChatFlood::Check(int64_t accountId, double now) {
    if (accountId <= 0) return ChatSendVerdict::Allow;
    auto& b = buckets_[accountId];
    if (b.last == 0) b.last = now;

    if (b.mutedUntil > 0) {
        if (now < (double)b.mutedUntil) return ChatSendVerdict::Muted;
        // Mute served. The bucket comes back FULL rather than empty: the
        // punishment was the minute of silence, and handing back an empty
        // bucket would drop the first thing they said afterwards and start
        // the drop count again from one message.
        b.mutedUntil = 0;
        b.consecutiveDrops = 0;
        b.tokens = kChatBurstTokens;
        b.last = now;
    }

    const double elapsed = std::max(0.0, now - b.last);
    b.last = now;
    b.tokens = std::min(kChatBurstTokens, b.tokens + elapsed * kChatTokensPerSec);

    if (b.tokens >= 1.0) {
        b.tokens -= 1.0;
        b.consecutiveDrops = 0;
        return ChatSendVerdict::Allow;
    }
    // Over budget. A drop costs no token — a flooder who keeps hammering
    // would otherwise push their own recovery further away with every
    // refused message, which turns a burst into an unbounded silence.
    if (++b.consecutiveDrops >= kChatDropsBeforeMute) {
        b.mutedUntil = (int64_t)now + kChatMuteSec;
        return ChatSendVerdict::Muted;
    }
    return ChatSendVerdict::Dropped;
}

int64_t ChatFlood::MutedUntil(int64_t accountId) const {
    auto it = buckets_.find(accountId);
    return it == buckets_.end() ? 0 : it->second.mutedUntil;
}

void ChatFlood::Prune(double now) {
    for (auto it = buckets_.begin(); it != buckets_.end();) {
        const bool idle = now - it->second.last > (double)(kChatMuteSec * 2);
        const bool notMuted = it->second.mutedUntil == 0 ||
                              now >= (double)it->second.mutedUntil;
        if (idle && notMuted) it = buckets_.erase(it);
        else ++it;
    }
}
