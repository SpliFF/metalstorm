// SSETickets — the credential an EventSource can actually carry.
//
// Task 9b (PLAN-lobby.md §3.2), and it exists because of a browser
// limitation rather than a design preference: `EventSource` cannot set
// request headers, so a stream that must know WHO is listening can only be
// told in the URL. The session token must not be what goes there — a URL
// reaches access logs, `Referer` and browser history, and that token is the
// account's durable, renewable, admin-capable credential.
//
// So the client POSTs (with its real Authorization header) for a ticket and
// opens `…/stream?ticket=…`. A leaked ticket buys someone a read-only feed of
// one account's chat for at most kSSETicketTtlSec of inactivity, and nothing
// else: it is not accepted anywhere but on an identified SSE channel.
//
// ── The TTL slides, and that is not laziness ───────────────────────────────
// A single-use ticket looks stricter and is unusable: `EventSource`
// auto-reconnects on its own, re-fetching the SAME url, so a ticket that
// expired on first redemption would break every reconnect the browser makes
// without telling the page. Redeeming refreshes the expiry instead, so a
// connected subscriber keeps its ticket alive by being connected, and a
// browser that has been gone longer than the window has to mint a new one
// (the client handles that on the EventSource error path).
#pragma once

#include <cstdint>
#include <mutex>
#include <string>
#include <unordered_map>

/// How long a ticket survives without being redeemed.
inline constexpr int64_t kSSETicketTtlSec = 15 * 60;

class SSETickets {
public:
    /// Mint a ticket for an account. `token` must already be unguessable —
    /// the caller passes one from the process's own generator so this class
    /// does not have to own an opinion about entropy.
    void Mint(const std::string& token, int64_t accountId, int64_t now) {
        if (token.empty() || accountId <= 0) return;
        std::lock_guard<std::mutex> lock(mutex_);
        PruneLocked(now);
        tickets_[token] = {accountId, now + kSSETicketTtlSec};
    }

    /// Resolve a ticket to its account, refreshing its expiry. Returns 0 for
    /// unknown or expired.
    int64_t Redeem(const std::string& token, int64_t now) {
        if (token.empty()) return 0;
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = tickets_.find(token);
        if (it == tickets_.end()) return 0;
        if (now >= it->second.expiresAt) {
            tickets_.erase(it);
            return 0;
        }
        it->second.expiresAt = now + kSSETicketTtlSec;
        return it->second.accountId;
    }

    /// Drop every ticket held by one account — logout, ban, password change.
    /// The session token going away must take the stream credential with it,
    /// or "log out" would leave a live feed open.
    int RevokeAccount(int64_t accountId) {
        std::lock_guard<std::mutex> lock(mutex_);
        int n = 0;
        for (auto it = tickets_.begin(); it != tickets_.end();) {
            if (it->second.accountId == accountId) { it = tickets_.erase(it); n++; }
            else ++it;
        }
        return n;
    }

    size_t Size() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return tickets_.size();
    }

    /// Parse `ticket=<value>` out of a raw query string. Here rather than in
    /// the route so the SSE resolver and any test read the same parser; the
    /// value is an opaque hex token from GenerateToken, so no percent-decode
    /// is needed and anything containing a character a token cannot contain
    /// simply fails to match a minted one.
    static std::string TicketFromQuery(const std::string& query) {
        size_t pos = 0;
        while (pos < query.size()) {
            const size_t amp = query.find('&', pos);
            const std::string pair = query.substr(pos, amp == std::string::npos
                                                          ? std::string::npos
                                                          : amp - pos);
            const size_t eq = pair.find('=');
            if (eq != std::string::npos && pair.substr(0, eq) == "ticket")
                return pair.substr(eq + 1);
            if (amp == std::string::npos) break;
            pos = amp + 1;
        }
        return "";
    }

private:
    struct Ticket {
        int64_t accountId = 0;
        int64_t expiresAt = 0;
    };

    void PruneLocked(int64_t now) {
        for (auto it = tickets_.begin(); it != tickets_.end();) {
            if (now >= it->second.expiresAt) it = tickets_.erase(it);
            else ++it;
        }
    }

    mutable std::mutex mutex_;
    std::unordered_map<std::string, Ticket> tickets_;
};
