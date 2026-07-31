# PHASE 0 — Reality check for `https://trade.home.arpa/`

**Date:** 2026-07-31 · **Capability target:** `READ_ONLY_DESK_PORTAL`
**Nothing was changed.** No Caddy file, DNS entry, firewall rule, service or
repository file was modified while producing this report.

---

## A. Repository

| Item | Value |
|---|---|
| Working clone (this machine) | `E:\JARVIS-BrainOps\projects\bagidea-office` |
| Current branch | `feature/javis-spot-command-center-bridge-v1` |
| Current HEAD | `f76c360c4db9d58b2033b5428516be139e4418e4` |
| `origin/main` | `73d5447b336454de934ca554426541716c1581c5` |
| Uncommitted | 1 file — `workspace/.claude/settings.json` (pre-existing, unrelated) |
| Plugins in this branch | binance, copilot-link, regime-radar, sentiment-autoscan, smc-radar, **spot-command-center**, trade-teams |

**PR #1 live state (fetched, not assumed):**
`state=OPEN · draft=true · mergeable=MERGEABLE · head=f76c360 · base=main`

Tests at this HEAD (recorded earlier today):
`node --test daemon/tests/*.test.js` → **253 tests · 229 pass · 7 fail · 17 skipped**.
The 7 failures are identical on `main` (5 meeting tests needing a live daemon,
one settings-path test, one SIGTERM test) — pre-existing, not caused by the PR.

> Note: `npm test` as defined in `package.json` runs **zero tests and exits 0**
> because the glob is quoted (`'daemon/tests/**/*.test.js'`) and Windows does not
> expand it. The real suite must be invoked as `node --test daemon/tests/*.test.js`.

---

## B. Runtime — where things actually run

**The BagIdea daemon does not run on the Creator's Windows workstation.**
It runs on the Linux server.

| Item | Value |
|---|---|
| Windows workstation | `192.168.0.80` — no Caddy on PATH, nothing listening on 8787/443/80 |
| Server | `javis-server` = **192.168.10.162** (Ubuntu, uptime 5+ days) |
| BagIdea daemon | `node daemon/server.js`, **PID 2828**, listening **`127.0.0.1:8787`** |
| Instances | **exactly one** — no duplicate daemon found |
| Startup owner | user systemd unit `bagidea-desk.service` (`enabled`, active since 2026-07-30 15:07) |
| Server repo | `/home/tiwa/bagidea-desk` on branch **`main` @ `73d5447`**, working tree **clean** |
| Plugins on the server | binance, copilot-link, regime-radar, sentiment-autoscan, smc-radar, trade-teams — **no `spot-command-center`** |

**Port 8787 is loopback-only today** (`ss -tlnp` shows `127.0.0.1:8787`), which
already satisfies the mission's network requirement. Nothing needs to change
there, and nothing should.

---

## C. How `https://javis.home.arpa/` actually works

| Layer | Mechanism (verified, not guessed) |
|---|---|
| Name resolution | **Windows hosts file on each client device** — `C:\Windows\System32\drivers\etc\hosts` contains `192.168.10.162 javis.home.arpa`. Public DNS returns NXDOMAIN. The server's own `/etc/hosts` has no `home.arpa` entry. There is **no** Pi-hole/AdGuard/router override involved. |
| Reverse proxy | **Caddy 2.6.2**, systemd `caddy.service` (`/usr/lib/systemd/system/caddy.service`, enabled), `ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile` |
| Root config | `/etc/caddy/Caddyfile` contains exactly one line: `import /etc/caddy/sites/*.caddy` |
| Site config | `/etc/caddy/sites/javis.home.arpa.caddy` (984 bytes, root-owned, only file in the directory) |
| Listener | `bind {$JAVIS_LAN_BIND:192.168.10.162}` — pinned to the LAN address, verified by `ss`: Caddy listens on `192.168.10.162:80` and `192.168.10.162:443`, **not** `0.0.0.0` |
| TLS | `tls internal` — Caddy's local CA |
| Upstream | `reverse_proxy 127.0.0.1:5189` (the hardened dashboard canary) with `header_up -Authorization` |
| Headers already set | `-Server`, `X-Content-Type-Options nosniff`, `X-Frame-Options DENY`, `Referrer-Policy no-referrer` |
| Logging | `/var/log/caddy/javis-access.log`, JSON, roll 10 MiB × 5 |
| **Authentication** | **none at the Caddy layer.** The site file states explicitly that authorization "is enforced by the loopback dashboard process, not by a client-side token or a Caddy route shortcut." |
| Firewall | `ufw` is **active**; the rule list needs sudo to read |
| Existing backups | **none** — no `.bak` files exist under `/etc/caddy/` |
| `trade.home.arpa` today | **does not exist** anywhere — no Caddy site, no hosts entry, no conflict |

**The pattern to reuse is therefore:** add one new file
`/etc/caddy/sites/trade.home.arpa.caddy` (additive — `import` picks it up without
editing any existing file), plus one hosts-file line per client device. This
touches nothing that `javis.home.arpa` depends on.

---

## D. Stop conditions encountered

Two of the mission's stop conditions are hit. I am reporting rather than
proceeding.

### 1. The Spot bridge does not exist on the deployment target

The portal is specified to render Spot Command Center data, but the server runs
`main @ 73d5447`, which has **no `spot-command-center` plugin**. The bridge lives
only on the unmerged Draft PR #1.

Reaching a Spot-populated portal would require one of:

| Option | Consequence |
|---|---|
| (a) Merge PR #1 | **Explicitly forbidden** by this mission and by the standing P1 gate |
| (b) Deploy the unmerged branch to the server | Ships Spot analytical logic whose A4/A6/A8 P1s are still open, and which currently has no canonical snapshot producer (Part C unimplemented) |
| (c) Ship the portal with Spot showing `NOT_AVAILABLE` | Honest, no new risk, but the Spot section is empty until PR #1 merges |
| (d) Defer the whole portal until PR #1 merges | No partial value delivered |

This is a Creator decision. My recommendation is **(c)**: build and deploy the
portal now with Futures live and Spot rendering a truthful
`SPOT BRIDGE — NOT INSTALLED ON THIS HOST` state, exactly as the mission already
requires for the Performance Journal. The Spot section then lights up on its own
the day PR #1 merges, with no further infrastructure work.

Related constraint that holds regardless of the option chosen: the Spot snapshot
`audit_status` is `PENDING_P1_HARDENING` (A4 FX truthfulness, A6 rate limiting
and A8 scanner correctness are still open). The portal must never display it as
`VERIFIED_LOCAL`.

### 2. Authentication has no existing mechanism to inherit

The mission says to reuse the authentication that protects `javis.home.arpa`.
**There is none at the proxy layer** — that site delegates authorization to the
dashboard application behind it. The BagIdea daemon's plugin routes have no auth
gate of their own (`plugins.js` dispatches `mod.routes[sub]` directly).

So a LAN-accessible `trade.home.arpa` requires **new** authentication, and the
only place to put it without touching the daemon is Caddy `basic_auth`. That is
permitted by the brief ("otherwise use a minimal local reverse-proxy
authentication method such as Caddy basic authentication"), but it is a new
mechanism rather than an inherited one, and it needs:

- a bcrypt hash generated by the Creator (`caddy hash-password`)
- the hash stored **only** in the server-side site file, never in Git
- the plaintext never recorded anywhere

I need the Creator to generate that hash, or to authorize me to generate one and
hand over the plaintext once, out of band.

### Non-blocking observations

- `ufw` is active but its rule list requires sudo. Before opening anything I
  must confirm 443 is already permitted from the LAN (it must be, since
  `javis.home.arpa` works) and that **no** rule for 8787 exists.
- Certain reads on the server need sudo (`/etc/caddy/Caddyfile` was readable,
  the Caddy CA directory was not). Writing the new site file and reloading Caddy
  will need sudo.
- The hosts-file mechanism is **per device**. `trade.home.arpa` will work only
  on machines where the line is added — the same limitation `javis.home.arpa`
  already has.

---

## E. Proposed design (not yet implemented)

```
Browser (LAN device with a hosts entry)
   │  https://trade.home.arpa/
   ▼
Caddy 2.6.2 on 192.168.10.162:443     ← new file /etc/caddy/sites/trade.home.arpa.caddy
   │  tls internal · basic_auth · deny-by-default route allowlist
   ▼
BagIdea daemon 127.0.0.1:8787          ← unchanged, still loopback-only
   ├── trading-desk-home plugin (new, read-only)
   ├── GET /plugin/binance/snapshot     (Futures context)
   └── GET /plugin/spot-command-center/* (only once PR #1 merges)
```

Allowed through the proxy: `GET /`, `GET /plugin/trading-desk-home/panel`,
`GET /plugin/trading-desk-home/state`, `GET /plugin/trading-desk-home/health`,
`GET /plugin/trading-desk-home/static/*`, favicon.
Everything else — including `/plugin/binance/cmd`, `/plugins/reload`, `/chat`,
`/perm/*`, `/registry/*`, `/sessions/*`, `/jobs`, `/event`, and every non-GET
method — denied by default.

Backups to be taken before any change:
`/etc/caddy/Caddyfile`, `/etc/caddy/sites/javis.home.arpa.caddy`,
`~/.config/systemd/user/bagidea-desk.service`, plus the Windows hosts file.

---

## F. What I need before proceeding

1. **Spot option** — confirm (c) "ship now with Spot NOT_INSTALLED", or choose
   another option above.
2. **Authentication** — provide a `caddy hash-password` bcrypt hash for the
   portal user, or authorize me to generate credentials and hand them over once.
3. **Sudo on `javis-server`** — confirm I may write
   `/etc/caddy/sites/trade.home.arpa.caddy`, run `caddy validate`, and
   `systemctl reload caddy` (a reload, not a restart, so `javis.home.arpa` never
   drops).

Plugin, read model, panel, tests and sanitized infrastructure templates can all
be built and committed **before** any of the above, since none of that touches
the server. Say the word and I will start there while the three answers come
back.
