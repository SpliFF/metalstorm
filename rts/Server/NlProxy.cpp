#include "NlProxy.h"

#include "HttpAuth.h"
#include "System/SpringLog/SpringLog.h"

#include <curl/curl.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <thread>

#define LOG_SECTION "server"

namespace NlProxy {

using json = nlohmann::json;

namespace {

constexpr const char* kApiUrl        = "https://api.anthropic.com/v1/messages";
constexpr const char* kApiVersion    = "anthropic-version: 2023-06-01";
constexpr int         kMaxTokens     = 1024;
constexpr long        kTimeoutMs     = 6000;   // §3: hard 6 s

std::string ReadFile(const std::filesystem::path& p) {
    std::ifstream in(p, std::ios::binary);
    if (!in) return {};
    std::ostringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

/// Read an env var, treating empty as unset. An exported-but-empty
/// `ANTHROPIC_API_KEY` is the classic way to end up authenticating with the
/// empty string and getting a confusing 401 instead of a clean "disabled".
std::string EnvOrEmpty(const char* name) {
    const char* v = std::getenv(name);
    if (v == nullptr) return {};
    std::string s = v;
    // Trim — a key pasted into a shell profile often carries a stray newline.
    while (!s.empty() && (s.back() == '\n' || s.back() == '\r' || s.back() == ' ' || s.back() == '\t'))
        s.pop_back();
    return s;
}

size_t WriteToString(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* out = static_cast<std::string*>(userdata);
    out->append(ptr, size * nmemb);
    return size * nmemb;
}

/// `{"error":"<code>"}` — the one error shape this route ever emits.
HttpResponse ErrorResponse(int status, const std::string& code) {
    return HttpAuth::JsonResponse(status, "{\"error\":\"" + HttpAuth::JsonEscape(code) + "\"}");
}

int IntField(const json& j, const char* key) {
    if (!j.is_object()) return 0;
    auto it = j.find(key);
    if (it == j.end() || !it->is_number_integer()) return 0;
    return it->get<int>();
}

}  // namespace

// ──────────────────────── model / effort configuration ─────────────────────

std::string ResolveModel(const std::string& raw) {
    if (raw.empty()) return kDefaultModel;
    // The value is spliced into a JSON body, so it is validated as an
    // identifier rather than escaped and hoped for. Model ids are ASCII
    // letters, digits, dash, dot and underscore; nothing else has ever been
    // one, and nothing else needs to be.
    const bool clean = raw.size() <= 64 && std::all_of(raw.begin(), raw.end(), [](unsigned char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
            || (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '_';
    });
    if (!clean) {
        SLOG(SPRING_LOG_WARNING, "nl-proxy: %s is not a plausible model id; using %s",
             kModelEnv, kDefaultModel);
        return kDefaultModel;
    }
    return raw;
}

std::string ResolveEffort(const std::string& raw) {
    if (raw.empty()) return kDefaultEffort;
    for (const char* ok : {"low", "medium", "high", "xhigh", "max"}) {
        if (raw == ok) return raw;
    }
    SLOG(SPRING_LOG_WARNING,
         "nl-proxy: %s='%s' is not low|medium|high|xhigh|max; using %s",
         kEffortEnv, raw.c_str(), kDefaultEffort);
    return kDefaultEffort;
}

// ────────────────────────── the latency/spend rollup ───────────────────────

void Stats::Record(const CallResult& call) {
    requests += 1;
    inputTokens      += call.inputTokens;
    outputTokens     += call.outputTokens;
    cacheReadTokens  += call.cacheReadTokens;
    cacheWriteTokens += call.cacheWriteTokens;

    if (call.status != 200) {
        failures += 1;
        return;
    }
    if (window.size() < kWindow) {
        window.push_back(call.latencyMs);
    } else {
        window[next] = call.latencyMs;
        next = (next + 1) % kWindow;
    }
}

int Stats::LatencyPercentile(int pct) const {
    if (window.empty()) return 0;
    std::vector<int> sorted = window;
    std::sort(sorted.begin(), sorted.end());
    if (pct <= 0) return sorted.front();
    if (pct >= 100) return sorted.back();
    const size_t idx = std::min(sorted.size() - 1,
                                static_cast<size_t>(sorted.size() * pct / 100));
    return sorted[idx];
}

bool Stats::DueForLog() const {
    return requests > 0 && (requests % kLogEvery) == 0;
}

std::string Stats::SummaryLine() const {
    std::ostringstream out;
    out << "nl-proxy: rollup n=" << requests
        << " failed=" << failures
        << " p50=" << LatencyPercentile(50) << "ms"
        << " p95=" << LatencyPercentile(95) << "ms"
        << " in=" << inputTokens
        << " out=" << outputTokens
        << " cache_read=" << cacheReadTokens
        << " cache_write=" << cacheWriteTokens;
    return out.str();
}

// ───────────────────────────── the token bucket ────────────────────────────

double RateLimiter::Refill(const Bucket& b, Clock::time_point now) {
    if (b.last == Clock::time_point{}) return kBurst;
    const auto elapsed = std::chrono::duration<double>(now - b.last).count();
    const double gained = elapsed * (kRefillPerMinute / 60.0);
    return std::min(kBurst, b.tokens + gained);
}

bool RateLimiter::Allow(int64_t userId, Clock::time_point now) {
    Bucket& b = buckets[userId];
    b.tokens = Refill(b, now);
    b.last = now;
    if (b.tokens < 1.0) return false;
    b.tokens -= 1.0;
    return true;
}

int RateLimiter::RetryAfterSeconds(int64_t userId, Clock::time_point now) const {
    auto it = buckets.find(userId);
    if (it == buckets.end()) return 0;
    const double tokens = Refill(it->second, now);
    if (tokens >= 1.0) return 0;
    const double deficit = 1.0 - tokens;
    const double seconds = deficit / (kRefillPerMinute / 60.0);
    // Round UP and never answer 0: a client told to wait zero seconds waits
    // zero seconds, which is exactly the hammering the limiter is here for.
    return std::max(1, static_cast<int>(seconds + 0.999));
}

void RateLimiter::Prune(Clock::time_point now) {
    for (auto it = buckets.begin(); it != buckets.end(); ) {
        if (Refill(it->second, now) >= kBurst) it = buckets.erase(it);
        else ++it;
    }
}

// ──────────────────────────── request validation ───────────────────────────

std::optional<RequestError> ParseRequest(const std::string& body, ParsedRequest& out) {
    // Size first — refusing a huge body should not require parsing it.
    if (body.size() > kMaxBodyBytes)
        return RequestError{413, "body-too-large"};

    json j = json::parse(body, nullptr, /*allow_exceptions=*/false);
    if (j.is_discarded() || !j.is_object())
        return RequestError{400, "bad-json"};

    auto uIt = j.find("utterance");
    if (uIt == j.end() || !uIt->is_string())
        return RequestError{400, "missing-utterance"};
    out.utterance = uIt->get<std::string>();

    // Trim so a whitespace-only utterance is refused rather than sent.
    const auto first = out.utterance.find_first_not_of(" \t\r\n");
    if (first == std::string::npos)
        return RequestError{400, "empty-utterance"};
    const auto last = out.utterance.find_last_not_of(" \t\r\n");
    out.utterance = out.utterance.substr(first, last - first + 1);

    if (out.utterance.size() > kMaxUtteranceChars)
        return RequestError{400, "utterance-too-long"};

    auto cIt = j.find("context");
    if (cIt == j.end() || !cIt->is_object())
        return RequestError{400, "missing-context"};
    out.contextJson = cIt->dump();

    auto hIt = j.find("history");
    if (hIt != j.end() && !hIt->is_null()) {
        if (!hIt->is_array())
            return RequestError{400, "bad-history"};
        if (hIt->size() > kMaxHistoryEntries)
            return RequestError{400, "history-too-long"};
        for (const auto& entry : *hIt) {
            if (!entry.is_string())
                return RequestError{400, "bad-history"};
            const std::string text = entry.get<std::string>();
            if (text.size() > kMaxUtteranceChars)
                return RequestError{400, "history-too-long"};
            out.history.push_back(text);
        }
    }

    return std::nullopt;
}

// ──────────────────────────── prompt assembly ─────────────────────────────

std::string BuildVocabularyTable(const std::string& classVocabularyJson) {
    json j = json::parse(classVocabularyJson, nullptr, /*allow_exceptions=*/false);
    if (j.is_discarded() || !j.is_object()) return {};

    std::ostringstream out;

    auto classesIt = j.find("classes");
    if (classesIt != j.end() && classesIt->is_object()) {
        // Sorted: nlohmann's object iteration order is already key-sorted, but
        // that is a property of its default container rather than a promise,
        // and this text is inside the cached prefix. Be explicit.
        std::vector<std::string> keys;
        for (auto it = classesIt->begin(); it != classesIt->end(); ++it) keys.push_back(it.key());
        std::sort(keys.begin(), keys.end());

        out << "UNIT CLASSES (the `class` field takes the key on the left):\n";
        for (const auto& key : keys) {
            const json& entry = (*classesIt)[key];
            if (!entry.is_object()) continue;
            out << "  " << key;
            const std::string display = entry.value("display", std::string{});
            if (!display.empty()) out << " — " << display;

            std::vector<std::string> words;
            if (auto p = entry.find("plural"); p != entry.end() && p->is_string())
                words.push_back(p->get<std::string>());
            if (auto s = entry.find("synonyms"); s != entry.end() && s->is_array())
                for (const auto& w : *s)
                    if (w.is_string()) words.push_back(w.get<std::string>());
            std::sort(words.begin(), words.end());
            words.erase(std::unique(words.begin(), words.end()), words.end());
            if (!words.empty()) {
                out << " (also called: ";
                for (size_t i = 0; i < words.size(); ++i) {
                    if (i) out << ", ";
                    out << words[i];
                }
                out << ")";
            }
            out << "\n";
        }
    }

    auto rolesIt = j.find("roles");
    if (rolesIt != j.end() && rolesIt->is_object()) {
        std::vector<std::string> keys;
        for (auto it = rolesIt->begin(); it != rolesIt->end(); ++it) keys.push_back(it.key());
        std::sort(keys.begin(), keys.end());
        if (!keys.empty()) {
            out << "ROLE PHRASES (map to the classes listed):\n";
            for (const auto& key : keys) {
                const json& entry = (*rolesIt)[key];
                std::vector<std::string> matched;
                if (auto m = entry.find("matches"); m != entry.end() && m->is_array())
                    for (const auto& match : *m)
                        if (match.is_object() && match.contains("class") && match["class"].is_string())
                            matched.push_back(match["class"].get<std::string>());
                std::sort(matched.begin(), matched.end());
                matched.erase(std::unique(matched.begin(), matched.end()), matched.end());
                out << "  \"" << key << "\" -> ";
                for (size_t i = 0; i < matched.size(); ++i) {
                    if (i) out << ", ";
                    out << matched[i];
                }
                out << "\n";
            }
        }
    }

    return out.str();
}

std::string BuildSystemPrompt(const std::string& instructions,
                              const std::string& schemaJson,
                              const std::string& vocabularyTable) {
    // The prose lives in `ui/nl-instructions.md`, not in a string literal here.
    //
    // It used to be literals, and `tools/nl-eval/run-eval.mjs` carried a JS
    // paraphrase of them — which is exactly how M7 found the two 4 KB apart:
    // M5 rewrote the rules of engagement in C++ and the eval kept scoring the
    // M4 wording, so every number it produced was about a prompt production
    // does not send. Pillar 5 ("one vocabulary, many consumers") applies to
    // the instructions as much as to the class list: the proxy and the eval
    // now read the same bytes off disk, and there is nothing left to drift.
    //
    // Only the two-line schema header below is still duplicated on both sides,
    // and the doctest that reports this prompt's byte count is the tripwire.
    std::ostringstream p;

    p << instructions;
    if (!instructions.empty() && instructions.back() != '\n') p << "\n";
    p << "\n";

    p << vocabularyTable;
    p << "\n";

    p << "THE SCHEMA\n"
         "\n"
         "Your entire reply is one object matching this JSON Schema:\n"
         "\n";
    p << schemaJson;
    p << "\n";

    return p.str();
}

std::string BuildUserTurn(const std::string& contextJson, const std::string& utterance) {
    std::ostringstream t;
    // The fence is opened and closed by US, and the utterance is placed after
    // the close. A name inside the payload that spells "</context>" therefore
    // ends up as a string inside a JSON document, not as a fence terminator —
    // the JSON encoding is doing the escaping, and the fence is a reading aid
    // on top of it rather than the actual boundary.
    t << "<context>\n" << contextJson << "\n</context>\n"
      << "\n"
      << "The player said:\n"
      << utterance << "\n";
    return t.str();
}

// ───────────────────────────── the proxy itself ────────────────────────────

bool Proxy::Init(const std::string& gameContentRoot) {
    enabled = false;

    apiKey = EnvOrEmpty(kPrimaryKeyEnv);
    if (apiKey.empty()) apiKey = EnvOrEmpty(kFallbackKeyEnv);
    if (apiKey.empty()) {
        SLOG(SPRING_LOG_NOTICE,
             "nl-proxy: disabled (neither %s nor %s is set) — /api/nl/command will 503 "
             "and clients fall back to the local parser",
             kPrimaryKeyEnv, kFallbackKeyEnv);
        return false;
    }

    const std::filesystem::path uiDir = std::filesystem::path(gameContentRoot) / "ui";
    schemaJson = ReadFile(uiDir / "nl-response.schema.json");
    const std::string vocabJson = ReadFile(uiDir / "class-vocabulary.json");
    const std::string instructions = ReadFile(uiDir / "nl-instructions.md");
    if (schemaJson.empty() || vocabJson.empty() || instructions.empty()) {
        SLOG(SPRING_LOG_WARNING,
             "nl-proxy: disabled — missing %s/nl-response.schema.json, class-vocabulary.json "
             "or nl-instructions.md",
             uiDir.string().c_str());
        apiKey.clear();
        return false;
    }

    // Strip the trailing newline the emitter writes: the schema goes into the
    // prompt as a document, not as a file, and a stray blank line at the end
    // of it is noise the cache would carry forever.
    while (!schemaJson.empty() && (schemaJson.back() == '\n' || schemaJson.back() == '\r'))
        schemaJson.pop_back();

    const std::string table = BuildVocabularyTable(vocabJson);
    if (table.empty()) {
        SLOG(SPRING_LOG_WARNING, "nl-proxy: disabled — class-vocabulary.json produced no table");
        apiKey.clear();
        return false;
    }

    systemPrompt = BuildSystemPrompt(instructions, schemaJson, table);
    // Resolved once, here, rather than read per request: the log line below is
    // then a truthful record of what this match spent its money on, and an env
    // change mid-match cannot make half the run unattributable.
    model  = ResolveModel(EnvOrEmpty(kModelEnv));
    effort = ResolveEffort(EnvOrEmpty(kEffortEnv));
    curl_global_init(CURL_GLOBAL_DEFAULT);
    enabled = true;
    SLOG(SPRING_LOG_NOTICE,
         "nl-proxy: enabled (model %s, effort %s, system prompt %zu bytes, key from %s)",
         model.c_str(), effort.c_str(), systemPrompt.size(),
         EnvOrEmpty(kPrimaryKeyEnv).empty() ? kFallbackKeyEnv : kPrimaryKeyEnv);
    return true;
}

CallResult Proxy::Call(const ParsedRequest& req) {
    CallResult result;
    const auto started = std::chrono::steady_clock::now();

    // ── the request body ──
    json system = json::array();
    system.push_back({
        {"type", "text"},
        {"text", systemPrompt},
        // The ONLY cache breakpoint. Everything before it is byte-stable;
        // everything after it (the whole `messages` array) is volatile.
        {"cache_control", {{"type", "ephemeral"}}},
    });

    json messages = json::array();
    // History alternates user/assistant, oldest first (§3 "≤2 prior exchanges").
    for (size_t i = 0; i < req.history.size(); ++i) {
        messages.push_back({
            {"role", (i % 2 == 0) ? "user" : "assistant"},
            {"content", req.history[i]},
        });
    }
    messages.push_back({
        {"role", "user"},
        {"content", BuildUserTurn(req.contextJson, req.utterance)},
    });

    json body = {
        {"model", model},
        {"max_tokens", kMaxTokens},
        // Thinking off + LOW effort by default: this is a parse, not a plan.
        // The schema does the structural work, and a command console that
        // takes eight seconds to move a squad is not a command console. Both
        // are env-overridable (M7) so the p50 can be tuned without a rebuild.
        {"thinking", {{"type", "disabled"}}},
        {"output_config", {
            {"effort", effort},
            {"format", {
                {"type", "json_schema"},
                {"schema", json::parse(schemaJson, nullptr, /*allow_exceptions=*/false)},
            }},
        }},
        {"system", system},
        {"messages", messages},
    };
    const std::string payload = body.dump();

    // ── the call ──
    CURL* curl = curl_easy_init();
    if (curl == nullptr) {
        result.status = 503;
        result.body = R"({"error":"nl-upstream"})";
        return result;
    }

    std::string response;
    curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "content-type: application/json");
    headers = curl_slist_append(headers, kApiVersion);
    // The key goes on a header we build here and free below. It is never
    // logged and never stored anywhere but `apiKey`.
    headers = curl_slist_append(headers, ("x-api-key: " + apiKey).c_str());

    curl_easy_setopt(curl, CURLOPT_URL, kApiUrl);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, payload.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(payload.size()));
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteToString);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, kTimeoutMs);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, 2000L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 0L);
    // Belt and braces: this endpoint is HTTPS and must stay HTTPS. A redirect
    // to http:// would put the key on the wire in clear text.
    curl_easy_setopt(curl, CURLOPT_PROTOCOLS_STR, "https");

    const CURLcode rc = curl_easy_perform(curl);
    long httpStatus = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpStatus);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    result.latencyMs = static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - started).count());

    if (rc != CURLE_OK) {
        // Timeout and transport failure are the SAME answer as "disabled" from
        // the client's point of view: fall back to the local parser. Logged
        // with the curl reason so a real outage is diagnosable.
        SLOG(SPRING_LOG_WARNING, "nl-proxy: upstream call failed after %d ms: %s",
             result.latencyMs, curl_easy_strerror(rc));
        result.status = 503;
        result.body = R"({"error":"nl-upstream"})";
        return result;
    }

    if (httpStatus == 429) {
        SLOG(SPRING_LOG_WARNING, "nl-proxy: upstream rate limited");
        result.status = 429;
        result.body = R"({"error":"nl-upstream-rate-limited"})";
        return result;
    }
    if (httpStatus < 200 || httpStatus >= 300) {
        // The upstream error body can contain the request echo; log only the
        // status and a short prefix so a key can never reach the log.
        SLOG(SPRING_LOG_WARNING, "nl-proxy: upstream HTTP %ld (%d ms): %.200s",
             httpStatus, result.latencyMs, response.c_str());
        result.status = 503;
        result.body = R"({"error":"nl-upstream"})";
        return result;
    }

    // ── the answer ──
    json parsed = json::parse(response, nullptr, /*allow_exceptions=*/false);
    if (parsed.is_discarded() || !parsed.is_object()) {
        SLOG(SPRING_LOG_WARNING, "nl-proxy: upstream returned unparseable body");
        result.status = 503;
        result.body = R"({"error":"nl-upstream"})";
        return result;
    }

    if (auto usage = parsed.find("usage"); usage != parsed.end()) {
        result.inputTokens     = IntField(*usage, "input_tokens");
        result.outputTokens    = IntField(*usage, "output_tokens");
        result.cacheReadTokens = IntField(*usage, "cache_read_input_tokens");
        result.cacheWriteTokens = IntField(*usage, "cache_creation_input_tokens");
    }

    // Check `stop_reason` BEFORE reading content — a refusal carries an empty
    // or partial content array, and indexing content[0] on one is how this
    // route would crash in production on a sentence nobody anticipated.
    const std::string stopReason = parsed.value("stop_reason", std::string{});
    if (stopReason == "refusal") {
        // A model-side decline is not a proxy failure, and falling back to the
        // slot-filler would just produce a worse answer to the same sentence.
        // Synthesise the envelope's own way of saying no.
        result.status = 200;
        result.body = R"({"actions":[{"kind":"refuse","reason":"I can't act on that one."}],)"
                      R"("say":"I can't act on that one."})";
        return result;
    }

    std::string text;
    if (auto content = parsed.find("content"); content != parsed.end() && content->is_array()) {
        for (const auto& block : *content) {
            if (block.is_object() && block.value("type", std::string{}) == "text")
                text += block.value("text", std::string{});
        }
    }
    if (text.empty()) {
        SLOG(SPRING_LOG_WARNING, "nl-proxy: upstream returned no text block (stop_reason=%s)",
             stopReason.c_str());
        result.status = 503;
        result.body = R"({"error":"nl-upstream"})";
        return result;
    }

    // Shape-check only. The envelope's real gate is `validateNLResponse` at the
    // client (§3 — "the client validator remains the second gate"), and this
    // side deliberately does not grow a second copy of that logic. What it does
    // check is that we are not handing the browser something that isn't JSON.
    json envelope = json::parse(text, nullptr, /*allow_exceptions=*/false);
    if (envelope.is_discarded() || !envelope.is_object()) {
        SLOG(SPRING_LOG_WARNING, "nl-proxy: structured output was not a JSON object");
        result.status = 503;
        result.body = R"({"error":"nl-upstream"})";
        return result;
    }

    result.status = 200;
    result.body = envelope.dump();
    return result;
}

Proxy::~Proxy() {
    // A detached worker is still holding `this`. The upstream call has a hard
    // 6 s timeout, so waiting a little past that is bounded — and the
    // alternative is a thread reading a destroyed prompt/key at process exit.
    // Only ever costs anything when a match is torn down mid-utterance.
    for (int i = 0; i < 700 && inFlight.load() > 0; ++i)
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
}

HttpResponse Proxy::Finish(int64_t userId, const ParsedRequest& req) {
    const CallResult call = Call(req);

    // §3: "log usage tokens per request". One line, greppable, no utterance
    // text — what the player said is theirs, and the metrics plane does not
    // need it to answer "what is this costing".
    if (call.status == 200) {
        SLOG(SPRING_LOG_NOTICE,
             "nl-proxy: ok user=%lld %dms in=%d out=%d cache_read=%d cache_write=%d",
             static_cast<long long>(userId), call.latencyMs, call.inputTokens,
             call.outputTokens, call.cacheReadTokens, call.cacheWriteTokens);
    }

    // M7 dashboard: the per-request line above answers "what did THIS cost";
    // this one answers "is the p50 still under the bar", which is the question
    // the model choice turns on and which no single request can answer.
    // Locked because M8 folds this from a worker thread: two concurrent
    // talkers would otherwise race the ring cursor and the token totals.
    std::string rollup;
    {
        std::lock_guard<std::mutex> lock(statsMutex);
        stats.Record(call);
        if (stats.DueForLog()) rollup = stats.SummaryLine();
    }
    if (!rollup.empty()) SLOG(SPRING_LOG_NOTICE, "%s", rollup.c_str());

    return HttpAuth::JsonResponse(call.status, call.body);
}

/// The gates that run before a single token is spent. Shared by the sync and
/// the deferred entry points so there is one answer to "may this request
/// proceed", not two that can drift.
std::optional<HttpResponse> Proxy::Admit(int64_t userId, const std::string& body,
                                         ParsedRequest& req) {
    if (!enabled)
        return ErrorResponse(503, "nl-disabled");

    if (auto err = ParseRequest(body, req))
        return ErrorResponse(err->status, err->code);

    if (!limiter.Allow(userId)) {
        const int retry = limiter.RetryAfterSeconds(userId);
        SLOG(SPRING_LOG_NOTICE, "nl-proxy: user %lld rate limited (retry in %ds)",
             static_cast<long long>(userId), retry);
        return ErrorResponse(429, "nl-rate-limited");
    }
    return std::nullopt;
}

HttpResponse Proxy::Handle(int64_t userId, const std::string& body) {
    ParsedRequest req;
    if (auto refused = Admit(userId, body, req))
        return *refused;
    return Finish(userId, req);
}

std::optional<HttpResponse> Proxy::HandleDeferred(int64_t userId, const std::string& body,
                                                  const DeferredResponse& defer) {
    ParsedRequest req;
    if (auto refused = Admit(userId, body, req))
        return refused;

    // The concurrency cap. fetch_add-then-check rather than a compare loop:
    // a transient overshoot by one is harmless here (the loser gives its slot
    // straight back), and the alternative is a CAS retry on the network thread.
    if (inFlight.fetch_add(1) >= kMaxConcurrentCalls) {
        inFlight.fetch_sub(1);
        SLOG(SPRING_LOG_NOTICE, "nl-proxy: user %lld refused — %d calls already in flight",
             static_cast<long long>(userId), kMaxConcurrentCalls);
        return ErrorResponse(503, "nl-busy");
    }

    // `req` is copied, not referenced: this frame is gone the moment we return
    // nullopt. `defer` is a shared handle — if the client hangs up or the match
    // ends, the server cancels it and the Complete() below becomes a no-op.
    std::thread([this, userId, req, defer]() {
        // The answer already has nowhere to go (client gone between dispatch
        // and this thread starting). Don't pay for a call nobody will read.
        if (!defer.Cancelled())
            defer.CompleteWith("/api/nl/command", [&] { return Finish(userId, req); });
        inFlight.fetch_sub(1);
    }).detach();

    return std::nullopt;
}

}  // namespace NlProxy
