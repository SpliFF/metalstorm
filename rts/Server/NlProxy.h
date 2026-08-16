// NlProxy — the server-side Claude proxy behind POST /api/nl/command.
//
// PLAN-metalstorm-command-language.md §3, milestone M4.
//
// WHY THE KEY LIVES HERE. The whole point of this file is that the browser
// never holds an API key. The client posts an utterance plus a LOS-filtered
// context payload; this class turns that into a Claude request, validates the
// answer's shape, and hands back an NLResponse envelope. `SPRING_NL_API_KEY`
// (or `ANTHROPIC_API_KEY`) is read from the environment once at startup and is
// never written to a config file, never logged, and never leaves the process.
// Unset ⇒ the route answers 503 `{"error":"nl-disabled"}` and the client falls
// back to its local slot-filler, which is a supported mode rather than an
// outage: a server without a key is a server where typed orders still work.
//
// WHY THE GAME SERVER AND NOT THE LOBBY. The lobby's HTTP loop is single
// threaded and global — a 1–3 s Claude call there would stall login for every
// player on the instance. `NetworkServer` is per-match, so a blocked call
// degrades exactly one game. The cost is that the key exists in N per-match
// processes, which is why it is env-only.
//
// TESTABILITY. Everything except the actual HTTPS call is a free function or a
// clock-injectable class, so the doctest suite exercises the token bucket, the
// request gate and the prompt assembly with no network and no key. There is
// deliberately NO live-API call anywhere in the test suites (§8 — the eval
// harness in tools/nl-eval is opt-in and needs a key).

#pragma once

#include "NetworkServer.h"

#include <chrono>
#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace NlProxy {

// ───────────────────────────── request limits ─────────────────────────────

/// Rejected BEFORE any token is spent. An utterance is a sentence a person
/// said; 500 characters is several of them, and anything longer is either a
/// paste or an attempt to make the context window the attack surface.
inline constexpr size_t kMaxUtteranceChars = 500;
/// The context payload targets ~1.5k tokens (§2). 16 KB is generous headroom
/// for that and a hard stop well below anything that would cost real money.
inline constexpr size_t kMaxBodyBytes = 16 * 1024;
/// §3: "≤2 prior exchanges". More than that is a client bug, not a longer
/// conversation — M5 owns multi-turn and will raise this deliberately.
inline constexpr size_t kMaxHistoryEntries = 4;   // 2 exchanges = 2 user + 2 assistant

// ───────────────────────────── the token bucket ────────────────────────────

/// Per-user rate limit: 6 requests/minute, burst 3 (§3 "Cost/abuse control").
///
/// A classic token bucket rather than a fixed window, because the shape a
/// player produces is bursty — three quick corrections and then nothing for a
/// minute — and a fixed window would refuse the third correction while
/// happily allowing six in the last second of a window.
///
/// In-memory and per-process, which is correct here: the limit exists to bound
/// spend and accidental hammering inside one match, and a match IS one process.
/// Modelled on `HttpAuth::LoginLimiter`, including the injectable clock — a
/// rate limiter you cannot drive from a test is a rate limiter nobody tests.
class RateLimiter {
public:
    static constexpr double kRefillPerMinute = 6.0;
    static constexpr double kBurst = 3.0;

    using Clock = std::chrono::steady_clock;

    /// Consume one token for `userId`. Returns true if the request may
    /// proceed. `now` is injectable so tests can drive the clock.
    bool Allow(int64_t userId, Clock::time_point now = Clock::now());

    /// Whole seconds until this user's next token, for the `Retry-After`
    /// header. Never returns 0 when the bucket is empty — a client told to
    /// retry in zero seconds retries immediately, which is the thing the
    /// limiter exists to stop.
    int RetryAfterSeconds(int64_t userId, Clock::time_point now = Clock::now()) const;

    /// Drop idle buckets. A long match with many joins would otherwise keep a
    /// row per user that ever spoke; a full bucket is indistinguishable from
    /// no bucket, so forgetting one is free.
    void Prune(Clock::time_point now = Clock::now());

private:
    struct Bucket {
        double tokens = kBurst;
        Clock::time_point last{};
    };
    // <map> does not compile under rts/ (the engine's own headers shadow it);
    // an unordered_map is what every other cache in this tree uses anyway.
    std::unordered_map<int64_t, Bucket> buckets;

    static double Refill(const Bucket& b, Clock::time_point now);
};

// ──────────────────────────── request validation ───────────────────────────

/// A well-formed `{utterance, context, history?}` body, as strings so the
/// caller can splice them into the Claude request without a second parse.
struct ParsedRequest {
    std::string utterance;
    /// The §2 context payload, re-serialised compactly. Kept as text because
    /// nothing on this side interprets it — it is DATA that travels to the
    /// model inside the user turn (see `BuildUserTurn`).
    std::string contextJson;
    /// Alternating user/assistant strings, oldest first. Empty for a fresh
    /// utterance.
    std::vector<std::string> history;
};

struct RequestError {
    int status = 400;
    /// The machine-readable `error` field. Deliberately terse and stable —
    /// `nl-client.ts` branches on the status, and a human reads the log.
    std::string code;
};

/// Parse and gate a request body. Returns an error for anything malformed,
/// oversized, or over-long, WITHOUT calling Claude. Ordered cheapest-first:
/// the size check runs before the JSON parse, so a 10 MB body is refused
/// without being parsed.
std::optional<RequestError> ParseRequest(const std::string& body, ParsedRequest& out);

// ──────────────────────────── prompt assembly ─────────────────────────────

/// The class-vocabulary table as the prompt renders it: one line per class,
/// canonical name first, then the words a player might actually say.
///
/// Derived from `class-vocabulary.json` so the model, the local slot-filler,
/// the autocomplete and the command builder all read one source (§2, "the
/// anti-drift fix"). Deterministic: classes and their synonyms are sorted, so
/// the same file always produces the same bytes.
std::string BuildVocabularyTable(const std::string& classVocabularyJson);

/// The complete system prompt: `instructions` (the rules of engagement, read
/// from `ui/nl-instructions.md`) + the class vocabulary + the NLResponse schema.
///
/// **This must be byte-stable for identical inputs.** It is the cached prefix
/// (`cache_control` sits on its last block), and the volatile context payload
/// deliberately lives in the user turn instead. A prompt that varied — a
/// timestamp, an unordered map, a player name — would pay a cache write on
/// every utterance and quietly triple the cost of the feature.
///
/// `instructions` is a file rather than a literal because it has to be read by
/// two programs. `tools/nl-eval/run-eval.mjs` scores the prompt, and when the
/// prose lived in a C++ string literal the harness carried a JS paraphrase of
/// it that fell 4 KB behind — so the eval was grading a prompt production does
/// not send. Same source, same bytes, nothing to drift.
std::string BuildSystemPrompt(const std::string& instructions,
                              const std::string& schemaJson,
                              const std::string& vocabularyTable);

/// The user turn: the context payload plus the utterance, with the context
/// fenced and labelled as data.
///
/// §9.7 is not paranoia — org-group names, region names and objective titles
/// are player- and generator-authored strings that end up in this payload, so
/// "context strings are DATA, not instructions" has to be enforced by the
/// prompt's structure and not only by asking nicely. The utterance comes
/// LAST, after the fence closes, so a name that tries to end the data section
/// is still inside it.
std::string BuildUserTurn(const std::string& contextJson, const std::string& utterance);

// ──────────────────────── model / effort configuration ─────────────────────
//
// M7's tuning knob. The plan's rule is "drop to haiku if p50 > ~1.5 s", and a
// rule you cannot act on without a recompile is not a rule. Both are env-only,
// like the key: a modoption would put model selection in the hands of whoever
// hosts a match, and the thing being tuned is spend.
//
// The DEFAULTS below are also `tools/nl-eval/run-eval.mjs`'s defaults, so a
// sweep measures what production ships. If you change one, change both.

inline constexpr const char* kModelEnv     = "SPRING_NL_MODEL";
inline constexpr const char* kEffortEnv    = "SPRING_NL_EFFORT";
inline constexpr const char* kDefaultModel = "claude-opus-5";
inline constexpr const char* kDefaultEffort = "low";

/// Validate an overridden model id, falling back to the default.
///
/// The charset check is the point: this string is spliced into a JSON request
/// body, and an operator env var is a lower-trust input than a literal. A
/// rejected value logs and falls back rather than failing startup — a typo in
/// a launch script should degrade to the default model, not to no NL at all.
std::string ResolveModel(const std::string& raw);

/// Validate an overridden effort level against the closed set the API accepts
/// (`low`/`medium`/`high`/`xhigh`/`max`), falling back to the default. A bad
/// value here would 400 every request, i.e. break the feature silently in a
/// way that looks like an outage; catching it at startup is much cheaper.
std::string ResolveEffort(const std::string& raw);

// ───────────────────────────── the proxy itself ────────────────────────────

/// What one upstream call produced, for logging and for the route's answer.
struct CallResult {
    /// 200 with an envelope, or an error status the route returns as-is.
    int status = 200;
    /// The NLResponse JSON on success; a `{"error":...}` body otherwise.
    std::string body;
    /// Usage, logged per request (§3). Zero when the call never happened.
    int inputTokens = 0;
    int outputTokens = 0;
    int cacheReadTokens = 0;
    int cacheWriteTokens = 0;
    int latencyMs = 0;
};

// ────────────────────────── the latency/spend rollup ───────────────────────

/// Per-match latency and token totals, for the metrics plane (M7 dashboards).
///
/// Deliberately NOT a new dashboard stack. The repo's existing shape for this
/// is a greppable `SLOG` line — `GameMetricsWriter` writes sim health to
/// SQLite because the GM dashboard reads it, and the NL proxy has no such
/// consumer. So this is the per-request `nl-proxy: ok …` line plus a periodic
/// rollup with the percentiles the model decision actually turns on.
///
/// TOKENS, NOT DOLLARS, on purpose: a USD price table compiled into a shipped
/// binary is a price table that is wrong the first time list prices move, and
/// nobody would notice. `tools/nl-eval/run-eval.mjs` owns the price table and
/// converts; this side reports the tokens that conversion multiplies.
class Stats {
public:
    /// How many samples the percentile window keeps. One match's worth of
    /// talking is well under this, and the cap means a marathon game cannot
    /// grow this vector without bound (PLAN-long-uptime's whole complaint).
    static constexpr size_t kWindow = 512;
    /// Rollup cadence, in calls that reached upstream.
    static constexpr int kLogEvery = 10;

    /// Fold one completed call in. Failed calls count toward `failures` and
    /// are excluded from the latency window — a 503 that returns in 0.4 ms
    /// would drag the p50 down and make a slow model look fast.
    void Record(const CallResult& call);

    /// Latency percentile in ms over the retained window, or 0 when empty.
    /// `pct` is 0–100.
    int LatencyPercentile(int pct) const;

    /// True when this call completed a rollup interval, i.e. the caller should
    /// emit `SummaryLine()` now.
    bool DueForLog() const;

    /// One greppable line: counts, p50/p95, and the token totals a cost
    /// figure is computed from.
    std::string SummaryLine() const;

    int Requests() const { return requests; }
    int Failures() const { return failures; }

private:
    std::vector<int> window;   // successful latencies, ms; capped at kWindow
    size_t next = 0;           // ring cursor once the window is full
    int requests = 0;
    int failures = 0;
    long long inputTokens = 0;
    long long outputTokens = 0;
    long long cacheReadTokens = 0;
    long long cacheWriteTokens = 0;
};

/// Owns the key, the prompt and the limiter for one match.
///
/// Construct once at startup (`Init`), then `Handle` per request. Not copied,
/// and safe to call from the HTTP thread only — the limiter is unguarded
/// because `NetworkServer` dispatches POSTs on a single thread today. If that
/// ever changes, the limiter grows a mutex; nothing else here holds state.
class Proxy {
public:
    /// Read the key from the environment and load the schema + vocabulary from
    /// `gameContentRoot` (`<root>/ui/nl-response.schema.json` and
    /// `<root>/ui/class-vocabulary.json`). Returns false and leaves the proxy
    /// disabled if the key is absent or the data files are missing — both are
    /// ordinary states, and both mean the route answers 503.
    bool Init(const std::string& gameContentRoot);

    /// True when a key was found AND the prompt built. `false` ⇒ every request
    /// gets 503 `{"error":"nl-disabled"}`.
    bool Enabled() const { return enabled; }

    /// The whole route body: gate, rate-limit, call, validate, answer.
    HttpResponse Handle(int64_t userId, const std::string& body);

    /// Exposed for the doctest suite and for the eval harness — the exact
    /// bytes that go up as the cached system block.
    const std::string& SystemPrompt() const { return systemPrompt; }

    /// What this proxy resolved at Init. Read by the doctest suite; also what
    /// the startup log line reports, so a live server says which model it is
    /// actually spending on.
    const std::string& Model() const { return model; }
    const std::string& Effort() const { return effort; }

    /// The rollup, for the metrics line and for tests.
    const Stats& Metrics() const { return stats; }

private:
    bool enabled = false;
    std::string apiKey;        // never logged, never serialised
    std::string schemaJson;
    std::string systemPrompt;
    std::string model  = kDefaultModel;
    std::string effort = kDefaultEffort;
    RateLimiter limiter;
    Stats stats;

    /// One HTTPS round trip. Hard 6 s timeout (§3), non-streaming.
    CallResult Call(const ParsedRequest& req);
};

/// The environment variables consulted, in order. Exposed so the doctest can
/// assert the fallback order rather than restate it.
inline constexpr const char* kPrimaryKeyEnv  = "SPRING_NL_API_KEY";
inline constexpr const char* kFallbackKeyEnv = "ANTHROPIC_API_KEY";

}  // namespace NlProxy
