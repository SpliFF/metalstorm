# Production Deployment Checklist

Everything an operator needs to take spring-lobby + spring-server from a dev
checkout to a public deployment. This is the task-7 deliverable of
[PLAN-security-hardening.md](../PLAN-security-hardening.md) — read that plan
for the full threat-model table and gap ledger this checklist closes against.

---

## 1. Build

- Configure with `-DSPRING_PROD=ON`. This **compiles out** (not just
  403s) the exec route, the SQL proxy, debug/test verbs, and dev-mode
  account auto-registration — see PLAN-security-hardening.md §2.
- CI enforces this with a symbol-grep gate
  (`.github/workflows/security-prod-gate.yml`): a prod binary containing any
  of the gated symbols fails the build. Don't bypass it.
- `spring-tests` (`ctest`) should be green on both the dev and the
  `SPRING_PROD` configuration before shipping a build.

```bash
cmake --preset release -DSPRING_PROD=ON
cmake --build --preset release --target spring-server spring-lobby
```

## 2. Process launch

- Every binary refuses to bind a public interface unless launched with
  `--i-understand-this-is-a-dev-build` **or** built with `SPRING_PROD` (see
  `rts/Server/DevBuildGate.h`). This is a documentation guard against
  accidentally exposing a dev build, not DRM — pass the flag once your
  process manager is configured correctly and move on.
- `spring-lobby` forks a `spring-server` child per room
  (`spawnGameServer` in `rts/lobby_main.cpp`) — it propagates
  `--i-understand-this-is-a-dev-build`, `--db`, and (see §3) `--wt-cert`/
  `--wt-key` to every child automatically. You configure these once at the
  lobby's own launch command.
- Run both binaries under a process supervisor (systemd, mprocs in dev) that
  restarts on crash and captures stdout/stderr to your log pipeline. Point
  `--log-server`/`--log-sqlite` at the log server for the unified
  logging/audit story (see [debugging-logging.md](debugging-logging.md)).

## 3. Reverse proxy (HTTP plane only)

The lobby's HTTP/1.1+HTTP/2 (h2c) surface — REST API, lobby UI, static
assets — sits behind a normal TLS-terminating reverse proxy. See
[PLAN-static-serving.md](../PLAN-static-serving.md) for the full config
options (Caddy is the recommended default: automatic Let's Encrypt, one
binary, one config file).

**This does not cover the game connection.** Realtime game traffic runs over
**WebTransport (QUIC/HTTP-3 on UDP)**, and the QUIC endpoint terminates its
own TLS inside `spring-server` — a reverse proxy sitting in front of the
lobby's TCP port cannot intercept or offload TLS for it. §4 is the part that
actually secures that endpoint.

**⚠ Loopback-trust warning — `LocalhostOrAdmin` routes behind a proxy.**
Some routes are registered with `RouteAuth::LocalhostOrAdmin` (today:
`POST /api/rooms/direct` on the lobby; `POST /api/exec` on dev-build game
servers — the latter is compiled out under `SPRING_PROD`). This gate trusts
the **`accept()`'d TCP peer address**: a connection from 127.0.0.1/::1 is
treated as an authenticated admin, no token required. A reverse proxy on the
same host connects to the backend **over loopback**, so blanket-proxying the
whole port makes every `LocalhostOrAdmin` route effectively **public and
unauthenticated** — the gate cannot tell the proxy apart from a local admin,
and it does not (and must not) trust `X-Forwarded-For`-style headers, which
any client can forge. The rule: **no `LocalhostOrAdmin` route may ever be
reachable through the reverse proxy.** Safe patterns:

- **Proxy an explicit allowlist of public routes only** (path-prefix
  forwarding for the UI, static assets, and the public `/api/*` set), rather
  than forwarding the entire backend port; or
- **Split the surfaces**: keep the proxied backend port free of any
  `LocalhostOrAdmin` route and bind localhost-trusting admin routes on a
  separate port/UNIX socket that the proxy never forwards to (reach it via
  SSH port-forward when needed).

Re-audit this whenever a new route is added with `LocalhostOrAdmin` — the
route-table snapshot (`NetworkServer::GetRegisteredRoutes()`, exercised by
`tests/test_route_auth.cpp`) lists every route's classification.

**`/api/metrics` is public by design** (unauthenticated `GET`, present in
prod builds): it exposes sim tick timings, entity/client counts, and — once
an admin enables the SimFrame profiler — per-phase sim cost breakdowns.
Nothing in it is secret-bearing, but it is operational intelligence (server
load, game size, player counts). Decide explicitly whether to expose it;
blocking or auth-gating it at the reverse proxy is the supported way to
restrict it.

## 4. WebTransport (QUIC) cert provisioning

PLAN-security-hardening.md task 5 / gap G3. `WebTransportServer` (`rts/Server/
WebTransport/WebTransportServer.{h,cpp}`) runs in one of two mutually
exclusive modes, selected by whether `--wt-cert`/`--wt-key` are passed to
`spring-server` (or, more commonly, to `spring-lobby`, which forwards them to
every spawned game server):

| | `hashes` mode (default) | `webpki` mode |
|---|---|---|
| Trigger | no `--wt-cert`/`--wt-key` | `--wt-cert <pem> --wt-key <pem>` |
| Cert | self-generated ECDSA P-256, ≤14-day validity, rolling pair | your CA cert (e.g. Let's Encrypt) |
| Client trust | pins via `serverCertificateHashes` (both the active and the pre-generated "next" hash, published by `/api/wt/info`) | normal WebPKI validation, no pinning |
| Use case | dev, self-hosted deployments without a domain | any deployment with a real domain — **use this in production** |

**Recommended prod setup:**

1. Get a cert for your domain (certbot standalone/webroot/DNS-01, or reuse
   whatever ACME client you already run for the HTTP proxy — the QUIC
   endpoint just needs a `fullchain.pem`/`privkey.pem` pair it can read).
2. Launch the lobby with `--wt-cert /etc/letsencrypt/live/<domain>/fullchain.pem
   --wt-key /etc/letsencrypt/live/<domain>/privkey.pem` (readable by the
   lobby/game-server user). Every room's spawned `spring-server` inherits
   these paths.
3. **Reload on renewal** — two mechanisms:
   - **Automatic (no operator action needed):** each `spring-server`
     re-`stat()`s its cert/key files hourly and hot-loads a changed pair into
     the live TLS context. Already-established QUIC connections keep the
     cert they handshaked with (TLS 1.3 doesn't renegotiate mid-session);
     only new connections see the new cert. Nothing drops. This is the
     supported mechanism — a `certbot renew` timer (or any ACME client's
     default renewal schedule) with no deploy-hook at all is sufficient;
     the new cert is live within an hour of the file changing.
   - **Fallback (heavier, for "I need it live *right now*"):** `kill -HUP
     <pid>` or `POST /api/restart` (admin-token-gated) triggers this
     binary's existing full restart-in-place (re-exec with the same argv,
     which re-reads `--wt-cert`/`--wt-key` from scratch). This also reloads
     the cert, but it drops every in-progress game on that process —
     reserve it for cases where waiting up to an hour genuinely isn't
     acceptable.
   - **Deliberate deviation from the original task-5 design:** the accepted
     design (PLAN-security-hardening.md §5 task 5) called for a `SIGUSR1`
     handler that forced an immediate, connection-preserving reload (a
     certbot `--deploy-hook` target). That was implemented, then **removed
     after testing found it reproducibly corrupts OpenSSL's heap state**:
     delivering *any* OS signal to `spring-server` while a `webpki`-mode
     (disk-loaded) cert was active caused a crash during process-exit
     cleanup (`OPENSSL_cleanup` → a double-free inside libcrypto's default
     library-context teardown) — reproduced 12+/12+ trials with the signal,
     0/11 without, and the crash occurred even with the reload handler's
     body reduced to a single no-op atomic write, so it is not a bug in
     this project's reload logic — it's a signal-delivery interaction with
     the OpenSSL/`ngtcp2_crypto_ossl` stack on this platform. The identical
     reload code path (`WebTransportServer::CheckCertReload`), exercised via
     the signal-free hourly poll, was verified safe. Given the crash is in
     the exact production configuration this task exists to enable, shipping
     the signal trigger was rejected — the hourly poll is the only reload
     path; `SIGHUP`/`POST /api/restart` remain the (unrelated, pre-existing,
     signal-safe-because-it-re-execs-into-a-fresh-process) fallback. If a
     genuinely immediate signal-free trigger is needed later, an
     admin-token-gated HTTP endpoint calling `WebTransportServer::
     ReloadCert()` directly (no signal involved) would sidestep this bug —
     that API is still exposed for exactly this purpose, just unwired.
4. Watch the server log line at startup and after every reload/rotation:
   `[webtransport] QUIC listening on udp/:<port> (mode=webpki certhash=...)`
   / `reloaded cert from disk` / `rotated self-signed cert`.

**`hashes` mode needs no cert management** — rotation is fully automatic
(half-life of the 13-day validity window, i.e. every ~6.5 days), and
`/api/wt/info` always publishes both the active and the next hash so a
client's cached answer survives one rotation. Only use it for deployments
without a stable domain to put a CA cert on.

**Manual verification (do this once per new deployment):** open the site in
a real Chrome/Edge build and confirm the game connects — `webpki` mode
should show a normal padlock; `hashes` mode should connect without
certificate warnings because the client is pinning the published hash, not
relying on WebPKI. Check `GET /api/wt/info` returns the `certMode` you
expect.

## 5. SQLite backup

The SQLite databases hold real state, not just cache — back them up
off-box on a schedule:

- `data/spring-server.db` — accounts, sessions, rooms, and (once
  [PLAN-persistence.md](../PLAN-persistence.md) lands) `game_snapshots`,
  which can hold **campaigns worth weeks of play**. This is the one that
  matters most; losing it loses player progress, not just convenience state.
- `data/debug.db` — log/session history via the log server. Lower value,
  but useful for post-incident triage; back up if you have the budget.

SQLite backs up safely with the online backup API or, simplest, `sqlite3
data/spring-server.db ".backup /backup/path/spring-server-$(date +%F).db"`
while the server is running (WAL mode makes this safe without stopping
writers — confirm the `journal_mode` pragma matches if you change storage
backends). Automate this on a cron/systemd timer; the admin audit table
(`admin_audit`, append-only) and any snapshot retention policy are not a
substitute for an off-box copy.

## 6. Content-loader hardening sweep

Two items from the PLAN-security-hardening.md gap ledger that specifically
touch the content-loading paths an operator's deployment exposes:

- **G11 — `/api/maps/thumb/*` traversal guard: fixed.** This route took a
  client-supplied map id and joined it directly onto `mapsDir` with no `..`
  guard, unlike every sibling content route. It now runs the same
  segment-based traversal check as `/api/content/assets/*`
  (`rts/Server/PathTraversal.h`, shared by both call sites) before touching
  the filesystem.
- **G21 — `/api/games/*` (`resources.json`) Lua-VM sandbox: confirmed NOT
  sandboxed.** `ResourcesParser::ParseGameResources` (`rts/Server/
  ResourcesParser.cpp`) spins up a bare `lua_State` to run a game's
  `gamedata/resources.lua`, and calls `luaL_openlibs(L)` — which opens the
  **full** Lua standard library, including `os` and `io`. A `resources.lua`
  file (or anything it `VFS.Include`s) can call `os.execute(...)`,
  `io.open(...)`, etc. with the lobby process's own filesystem/OS
  permissions; the custom `VFS.Include`/`VFS.LoadFile` traversal guards in
  that file only constrain the *custom* VFS surface, not the stdlib.
  **This is bounded by a trust boundary, not by the sandbox:** the plan
  classifies this route's inputs as "admin/dev inputs mostly" (§1.1) — the
  Lua file comes from a game package an operator installed under
  `data/games/`, not from an untrusted network client. **Operator
  requirement: only install game packages from sources you trust**, the same
  way you'd trust any other code you run with your server's permissions. If
  this project ever needs to support installing untrusted/third-party game
  packages, `ResourcesParser`'s `luaL_openlibs` needs to be replaced with a
  narrower set of library openers (string/table/math only, no `os`/`io`/
  `package`) — that hardening is out of scope here and not currently
  planned; flagging it so it isn't rediscovered from scratch.

## 7. Checklist

- [ ] Built with `-DSPRING_PROD=ON`; `spring-tests` green on both configs
- [ ] Every process launched with `--i-understand-this-is-a-dev-build` or a
      `SPRING_PROD` build (no accidental dev-build public exposure)
- [ ] Reverse proxy terminates TLS for the HTTP/lobby plane (PLAN-static-serving.md)
- [ ] No `LocalhostOrAdmin` route reachable through the reverse proxy — the
      proxy connects over loopback and would make the gate public (§3);
      proxy only the public route set, or split admin routes onto a
      non-proxied port/socket
- [ ] Decided whether `/api/metrics` (public, unauthenticated — tick times,
      entity/client counts) stays exposed, and blocked it at the proxy if not
      (§3)
- [ ] `--wt-cert`/`--wt-key` configured on the lobby (webpki mode) for any
      deployment with a real domain; no deploy-hook needed — the hourly
      auto-reload picks up a renewed cert on its own (§4)
- [ ] `GET /api/wt/info` returns the expected `certMode`; a real browser
      connects without warnings
- [ ] `data/spring-server.db` backed up off-box on a schedule
- [ ] Only trusted game packages installed under `data/games/` (§6, G21)
- [ ] Admin accounts provisioned via `--promote-admin` (spring-lobby), not
      left at whatever the first registered user happened to be
