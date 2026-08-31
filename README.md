# RingQ eFax — Complete Architecture & Setup Guide

Multi-tenant eFax solution built on RingQ's existing RingQ platform. This document covers the full architecture, server setup, RingQ-side configuration, dashboard deployment, API reference, and every real issue encountered and fixed during development.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Prerequisites](#2-prerequisites)
3. [Server Directory Setup](#3-server-directory-setup)
4. [Backend Installation](#4-backend-installation)
5. [Systemd Services](#5-systemd-services)
6. [nginx Configuration](#6-nginx-configuration)
7. [RingQ Configuration](#7-ringq--side-configuration)
8. [Dashboard (Frontend) Setup](#8-dashboard-frontend-setup)
9. [Database Schema](#9-database-schema)
10. [API Reference](#10-api-reference)
11. [T.38 Configuration & Findings](#11-t38-configuration--findings)
12. [Troubleshooting Guide](#12-troubleshooting-guide)
13. [Known Limitations](#13-known-limitations)

---

## 1. Architecture Overview

```
RingQ Portal (Flutter web)
    |
    | links to /fax/?token=<session_token>
    v
nginx (sgringq97.ringq.ai)
    |
    +-- /fax/      -> React dashboard (static files)
    +-- /fax-api/  -> proxy -> api_server.py (FastAPI, port 8000)
    +-- /fax-api/ requests carry the same RingQ session token
        already used everywhere else in the app

api_server.py (FastAPI/uvicorn, port 8000)
    - Pure HTTP + Postgres. No RingQ connection.
    - Auth: validates token against RingQ's own q_tokens table
    - Reads/writes fax_jobs, fax_domain_settings
    - Resolves gateways live from RingQ's own q_dids + v_gateways

fax_worker.py / fax_service.py (single persistent process)
    - The ONLY process that talks to RingQ (via ESL)
    - Polls fax_jobs for queued outbound sends -> originates calls
    - Listens for CHANNEL_ANSWER / CHANNEL_HANGUP_COMPLETE
      to create and finalize inbound job records
    - One process serves every domain on the PBX -- ESL has
      no concept of "domain", that's an application-layer idea

Postgres (RingQ's own `ringq` database -- shared, not separate)
    - fax_jobs, fax_domain_settings (our tables)
    - q_tokens, q_dids, v_gateways, q_companies (RingQ's own tables, read-only to us)

RingQ
    - Dialplan entries per fax-enabled DID (see Section 7)
    - Gateways registered per SIP trunk (RingQ-managed)
```

**Key design decisions, and why:**

- **No separate login.** Fax auth reuses RingQ's existing session tokens (`q_tokens`) directly -- the dashboard is reached via a URL carrying the same token the rest of RingQ already uses.
- **Multi-tenant by `domain_uuid`, not a separate deployment per customer.** Every table, every query, every job is scoped by `domain_uuid` resolved from the auth token -- one instance of this whole stack serves every RingQ customer on the PBX.
- **Gateway resolution is live, not cached.** `GET /fax/dids` and outbound sending both resolve the correct SIP trunk per number, per request, straight from RingQ's own `q_dids`/`v_gateways` tables -- there's no separate "fax numbers" list to keep in sync (an earlier design had one; it was removed -- see Section 12).
- **`fax_worker.py` is a single, PBX-wide process**, not one per domain. It reads `domain_uuid` directly off each job/channel to know which tenant it belongs to.

---

## 2. Prerequisites

- **RingQ already running**, with RingQ's existing multi-tenant Postgres schema (`q_dids`, `v_gateways`, `q_tokens`, `q_companies`, `v_dialplans`, `v_dialplan_details`)
- **Python 3.11+** with `venv`
- **Node.js 16+** and `npm` (for building the dashboard -- pin `vite@^4.5.5` if on Node 16, see Section 8)
- **ghostscript** and **libtiff-tools** (PDF<->TIFF conversion)
- **Postgres access** to the `ringq` database (credentials read automatically from `/etc/ringq/config.conf` -- see `config.py`)
- **`mod_spandsp` loaded in RingQ** (`fs_cli -x "show modules" | grep -i sofia` and confirm `mod_spandsp` similarly -- most RingQ installs have this by default)
- Root/sudo access on the RingQ box for systemd, nginx, and dialplan changes

---

## 3. Server Directory Setup

```bash
mkdir -p /var/www/fax-engine
mkdir -p /var/www/fax-dashboard/dist
mkdir -p /var/spool/fax/{outbound_pdf,outbound_tiff,inbound_tiff,inbox}

chown -R www-data:www-data /var/www/fax-engine /var/www/fax-dashboard /var/spool/fax
```

---

## 4. Backend Installation

```bash
cd /var/www/fax-engine
python3 -m venv venv
source venv/bin/activate
pip install --break-system-packages fastapi uvicorn python-multipart psycopg2-binary greenswitch gevent
```

Copy the backend source files (`api_server.py`, `config.py`, `converters.py`, `db.py`, `fax_service.py`, `fax_worker.py`) into `/var/www/fax-engine/`.

**`.env`** (place at `/var/www/fax-engine/.env`):

```bash
# Database credentials are read automatically from
# /etc/ringq/config.conf -- do not set DB_* here unless overriding
# for local testing.

FS_ESL_HOST=127.0.0.1
FS_ESL_PORT=8021
# Read the real value from
# /etc/RingQ/autoload_configs/event_socket.conf.xml
FS_ESL_PASSWORD=ClueCon

OUTBOUND_PDF_DIR=/var/spool/fax/outbound_pdf
OUTBOUND_TIFF_DIR=/var/spool/fax/outbound_tiff
INBOUND_TIFF_DIR=/var/spool/fax/inbound_tiff
INBOX_PDF_DIR=/var/spool/fax/inbox

FAX_RESOLUTION=204x196

# See Section 11 -- confirmed via direct testing that this
# RingQ/mod_spandsp build has a T.38 bug (negotiates fine, never
# actually transfers data afterward). Leave false until a future
# RingQ/libspandsp upgrade is tested from scratch.
FAX_ENABLE_T38=false

WORKER_POLL_INTERVAL=1.5
STALE_JOB_TIMEOUT_SECONDS=180
HEARTBEAT_INTERVAL_SECONDS=30
```

---

## 5. Systemd Services

**`/etc/systemd/system/ringq-fax-api.service`**
```ini
[Unit]
Description=RingQ Fax API (FastAPI HTTP server)
After=network.target postgresql.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/fax-engine
EnvironmentFile=/var/www/fax-engine/.env
ExecStart=/var/www/fax-engine/venv/bin/uvicorn api_server:app --host 127.0.0.1 --port 8000
Restart=always

[Install]
WantedBy=multi-user.target
```

**`/etc/systemd/system/ringq-fax-worker.service`**
```ini
[Unit]
Description=RingQ Fax Worker (RingQ ESL fax engine, multi-tenant)
After=network.target RingQ.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/fax-engine
EnvironmentFile=/var/www/fax-engine/.env
ExecStart=/var/www/fax-engine/venv/bin/python3 fax_worker.py
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now ringq-fax-api ringq-fax-worker
systemctl status ringq-fax-api ringq-fax-worker
```

---

## 6. nginx Configuration

Insert into the existing `443` server block for the RingQ domain (order matters -- see the warning below):

```nginx
location = /fax { return 301 /fax/$is_args$args; }

location ^~ /fax/ {
    alias /var/www/fax-dashboard/dist/;
    try_files $uri $uri/ /fax/index.html;
    index index.html;
}

location ^~ /fax-api/ {
    client_max_body_size 20M;
    proxy_pass http://127.0.0.1:8000/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

**Two things that WILL break this if missed, confirmed the hard way:**

1. **`^~` is mandatory on both `/fax/` and `/fax-api/` blocks.** Without it, an existing regex block matching `.css`/`.js` files elsewhere in the config takes precedence and 404s every dashboard asset -- a plain `location /fax/` loses to `location ~* \.(?:css|js)$` regardless of definition order.
2. **The bare `/fax` redirect must include `$is_args$args`.** `return 301 /fax/;` on its own silently drops any query string -- including the `?token=...` the whole auth flow depends on -- so a link like `/fax?token=xyz` would redirect to `/fax/` with the token gone.

```bash
nginx -t && systemctl reload nginx
```

---

## 7. RingQ Side Configuration

### 7.1 Understanding gateway resolution (context, no action needed)

`db.py`'s `get_did_gateway()`/`list_domain_dids()` join RingQ's `q_dids` (which number belongs to which trunk, by friendly name) against `v_gateways` (that trunk's actual RingQ config) to resolve, per number, per request:

```sql
SELECT g.gateway, g.gateway_uuid, g.enabled
FROM q_dids d
JOIN v_gateways g ON g.gateway = d.sip_trunk_name AND g.domain_uuid = d.domain_uuid
WHERE d.domain_uuid = %s AND d.did_number = %s
```

**Critical gotcha**: the actual RingQ dial string must use `gateway_uuid`, **not** the friendly `gateway` name column. RingQ keys gateways by UUID internally (friendly names are only unique *within* one domain, not across the whole multi-tenant PBX -- two different customers could both name a trunk "main"). Confirmed directly: `fs_cli -x "sofia status gateway"` never shows the friendly name, only the UUID.

### 7.2 Outbound Rules -- required per number, separate from gateway assignment

Even though our worker dials the gateway directly (bypassing RingQ's Outbound Route *dialplan matching* entirely), RingQ's own **Outbound Rules** feature appears to be a separate authorization layer gating which Caller IDs may originate calls on a trunk at all -- regardless of how the call was placed. Confirmed empirically: without a matching Outbound Rule, calls fail with total silence (`"Timed out waiting for initial communication"`); creating one with the correct Caller ID fixes it immediately.

**For every new fax number: create an Outbound Rule in RingQ with that number set as the Caller ID**, in addition to its `q_dids` gateway assignment. This is not optional and not automatic.

### 7.3 Inbound dialplan -- the proven template

**Use a plain `dialplan_xml` text blob in `v_dialplans`, not `v_dialplan_details` rows.** The normalized-row approach was repeatedly unreliable in practice (edits silently failed to take effect even after `reloadxml` or a full RingQ restart); the direct XML text edit is what's actually proven reliable, consistently.

```sql
-- STEP 0: check for an existing row for this number first.
SELECT dialplan_uuid, dialplan_order, dialplan_enabled
  FROM v_dialplans WHERE dialplan_number = '<DID_NUMBER>';

-- If one exists, DISABLE it rather than editing it in place (see 12.6):
UPDATE v_dialplans SET dialplan_enabled = 'false'
  WHERE dialplan_uuid = '<OLD_UUID>';

-- STEP 1: insert a fresh entry with a brand-new UUID.
BEGIN;
INSERT INTO v_dialplans
    (domain_uuid, dialplan_uuid, app_uuid, hostname, dialplan_context,
     dialplan_name, dialplan_number, dialplan_destination, dialplan_continue,
     dialplan_xml, dialplan_order, dialplan_enabled, dialplan_description,
     insert_date, insert_user, update_date, update_user)
VALUES
    ('<DOMAIN_UUID>', '<NEW_UUID>', NULL, NULL, 'public',
     'RingQ-Fax-In-<DID_NUMBER>', '<DID_NUMBER>', NULL, 'false',
     '<extension name="<DID_NUMBER>" continue="false" uuid="<NEW_UUID>">
    <condition field="${destination_number}" expression="^((\+)?<DID_NUMBER>)$">
        <action application="set" data="fax_direction=in"/>
        <action application="set" data="domain_uuid=<DOMAIN_UUID>"/>
        <action application="set" data="fax_verbose=true"/>
        <action application="set" data="fax_enable_t38=false"/>
        <action application="set" data="fax_enable_t38_request=false"/>
        <action application="set" data="fax_enable_ecm=true"/>
        <action application="set" data="ignore_early_media=true"/>
        <action application="set" data="fax_file=/var/spool/fax/inbound_tiff/${uuid}.tiff"/>
        <action application="answer" data=""/>
        <action application="stop_record_session" data="${record_path}/${record_name}"/>
        <action application="rxfax" data="${fax_file}"/>
        <action application="hangup" data=""/>
    </condition>
</extension>',
     0, 'true', 'RingQ fax inbound handler for <DID_NUMBER>',
     now(), NULL, NULL, NULL);
COMMIT;
```

```bash
fs_cli -x "reloadxml"
```

**Then verify with a live trace before testing a real call -- do not skip this:**
```bash
fs_cli
/log 7
```
Send a test fax, confirm the trace shows the correct `fax_enable_t38` and `domain_uuid` values, *then* treat the actual fax result as the real test.

**Four hard-won rules for this template, all confirmed by real failures during development:**

1. **`domain_uuid` must be set explicitly, by literal value.** Without it, the worker silently skips creating a job -- even if the fax itself succeeds perfectly and a real page is written to disk. (`"no domain_uuid on the channel -- Skipping"` in the worker log is the tell.)
2. **`fax_enable_t38` must be `false`.** See Section 11.
3. **If a row for this number already exists, disable it and insert fresh with a new UUID rather than editing in place.** Editing an existing row's `dialplan_xml` has repeatedly, silently failed to take effect -- surviving even a full `systemctl restart freeswitch` -- while a brand-new UUID with identical content works immediately. Not fully root-caused; the workaround is reliable regardless.
4. **If RingQ's own DID-assignment UI is touched again for this number later**, it may silently create a *new*, competing row for the same number (it has not been observed to delete rows we created). If fax stops working after any such change, check for a duplicate first:
   ```sql
   SELECT dialplan_uuid, dialplan_order, dialplan_enabled
     FROM v_dialplans WHERE dialplan_number = '<DID_NUMBER>'
     ORDER BY dialplan_order;
   ```
   Disable whichever row isn't the one this system created.

---

## 8. Dashboard (Frontend) Setup

React + Vite. Key design point: **`API_BASE` is computed at runtime from `window.location.origin`**, never hardcoded -- the same build works unmodified on any RingQ instance/domain it's deployed to.

```bash
cd fax_dashboard_app
npm install
npm run build
scp -r dist/* root@<server>:/var/www/fax-dashboard/dist/
```

**Auth flow**: the dashboard reads a `?token=...` query param from its own URL and attaches it as `Authorization: Bearer <token>` on every API call (and as a `?token=` param specifically on file-download links, since plain `<a href>` navigation can't carry custom headers). With no token present, it falls back to a demo-data mode rather than failing silently.

**Embedding in the RingQ portal**: whatever links to `/fax/` from within RingQ (Flutter) should construct:
```
https://<ringq-domain>/fax/?token=<the current user's real session token>
```
For a tab-like experience matching Chat/SMS (no page navigation), embed via `<iframe>`/webview rather than a plain link -- confirmed no `X-Frame-Options`/CSP blocker is present, so same-origin framing works without any nginx changes.

---

## 9. Database Schema

Two tables, created automatically on first API server startup (`db.init_db()`):

```sql
CREATE TABLE IF NOT EXISTS fax_jobs (
    id UUID PRIMARY KEY,
    domain_uuid UUID NOT NULL,
    direction TEXT NOT NULL,          -- 'in' | 'out'
    from_number TEXT,
    to_number TEXT,
    pages INTEGER DEFAULT 0,
    status TEXT NOT NULL,             -- see Section 10 for lifecycle
    file_path TEXT,
    call_uuid TEXT,
    esl_job_uuid TEXT,
    error_reason TEXT,
    created_at DOUBLE PRECISION NOT NULL,
    updated_at DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fax_jobs_domain ON fax_jobs(domain_uuid);
CREATE INDEX IF NOT EXISTS idx_fax_jobs_call_uuid ON fax_jobs(call_uuid);
CREATE INDEX IF NOT EXISTS idx_fax_jobs_esl_job_uuid ON fax_jobs(esl_job_uuid);
CREATE INDEX IF NOT EXISTS idx_fax_jobs_status ON fax_jobs(direction, status);

CREATE TABLE IF NOT EXISTS fax_domain_settings (
    domain_uuid UUID PRIMARY KEY,
    fax_ident TEXT,
    fax_header TEXT,
    updated_at DOUBLE PRECISION NOT NULL
);
```

**Note:** an earlier design also had a `fax_numbers` table for manually curating which numbers were fax-enabled. It's retired -- `GET /fax/dids` now reads live from RingQ's own `q_dids`/`v_gateways` instead, since that's always accurate and needs no separate management step. The table may still physically exist in Postgres from earlier deployments; nothing in the current code references it, and it's safe to leave or drop.

**Every function touching `fax_jobs` takes `domain_uuid` and filters by it -- this is the actual tenant-isolation boundary.** As long as `api_server.py` never calls these without the requesting customer's own `domain_uuid` (resolved from their auth token, never from anything the request claims), one domain's data can never be read or modified by another.

---

## 10. API Reference

Full endpoint reference, request/response shapes, and the complete inbound/outbound status lifecycle -- **kept as a separate document**, `API.md`, since it's substantial enough to stand alone and gets referenced independently by anyone building a client against this backend.

**Quick summary** (see `API.md` for full detail):

| Endpoint | Purpose |
|---|---|
| `POST /fax/send` | Queue an outbound fax (multipart: `to_number`, `from_number`, `file`) |
| `GET /fax/jobs?limit=N` | List jobs for this domain, most recent first |
| `GET /fax/jobs/{job_id}` | Poll a single job's status |
| `GET /fax/inbox/{job_id}/file` | Download a received fax PDF (only when `status: "received"`) |
| `GET /fax/dids` | List numbers this domain can send from |
| `GET`/`PUT /fax/settings` | Fax ident/header per domain |

**Status lifecycle:**
```
Outbound:  queued -> dialing -> sending -> sent
                                        -> failed
Inbound:   receiving -> received
                      -> failed
```
Auth is a Bearer token validated against RingQ's own `q_tokens` -- no separate login. There is **no push/websocket mechanism** -- all "real-time" behavior is polling (`GET /fax/jobs` every ~4s for a list, `GET /fax/jobs/{job_id}` every ~1.2s while tracking one active send).

---

## 11. T.38 Configuration & Findings

**Current state: T.38 is OFF everywhere, both directions, and this is a proven, deliberate configuration -- not a temporary workaround.**

There are **two independent switches**, controlling two different directions, that do not affect each other:

| Direction | Where it's set |
|---|---|
| Outbound (we call out) | `.env` -> `FAX_ENABLE_T38=false`, restart `ringq-fax-worker` |
| Inbound (someone calls us), per number | That number's dialplan XML -> `fax_enable_t38=false` |

**Evidence, gathered across extensive real-device testing:**
- **Outbound**: T.38 negotiates successfully (confirmed via SDP trace -- real `image/t38`/UDPTL exchange), then `mod_spandsp` stalls indefinitely afterward -- no actual page data ever transfers. A UDPTL packet capture showed our side transmitting exactly 2 redundant indicator packets after negotiation, then going completely silent for the rest of the call while the far end kept retrying.
- **Inbound, passive** (`fax_enable_t38=true`, `fax_enable_t38_request=false`): never even attempts negotiation against a real T.38-strict machine.
- **Inbound, active** (`fax_enable_t38_request=true`, tested clean with a fresh dialplan entry, no caching ambiguity): still failed the same way.
- **Root cause for the strict-machine case, confirmed via `sngrep` capture**: the far-end fax machine demands T.38 in the very first SDP answer and hangs up within milliseconds if it doesn't get it (`INVITE -> our audio-only 200 OK -> their BYE, 33ms later`). RingQ's standard model always answers audio-first and proposes T.38 via a *separate* re-INVITE afterward -- a hard architectural mismatch with this device's stricter expectation, not a settings problem.

**Practical requirement for any customer's fax machine**: T.38 must be disabled at the device itself for reliable operation on this platform. This needs to be documented in customer onboarding, not just here.

**Revisit only after a RingQ/libspandsp upgrade**, and re-test from scratch -- don't assume a version bump fixes it without direct verification.

---

## 12. Troubleshooting Guide

Real issues hit during development, and their actual fixes -- not hypothetical scenarios.

| Symptom | Cause | Fix |
|---|---|---|
| Dashboard shows blank page / 404 on `.js`/`.css` | An existing regex `location` block elsewhere in nginx intercepts asset requests before reaching `/fax/` | Add `^~` to both the `/fax/` and `/fax-api/` location blocks (Section 6) |
| `?token=...` disappears after visiting `/fax` (no trailing slash) | `return 301 /fax/;` drops the query string on redirect | Use `return 301 /fax/$is_args$args;` |
| Dashboard shows demo data even with a token in the URL | Browser cached an earlier (broken) redirect | Hard refresh, or test in a private/incognito window |
| `INVALID_GATEWAY` on originate | Dial string used the friendly gateway name instead of `gateway_uuid` | Use `gateway_uuid` from `v_gateways`, not `gateway` (see 7.1) |
| `INVALID_GATEWAY` even with a correct-looking gateway name | Gateway exists in the DB but RingQ hasn't loaded it live | `fs_cli -x "sofia profile external rescan"`, then re-check `sofia status gateway` |
| `Parse Error` on originate, immediate `DESTINATION_OUT_OF_ORDER` | Unquoted space in `fax_header`/`fax_ident` broke the `{key=value,...}` parser | Wrap any value containing a space/comma in single quotes before building the dial string |
| `CHAN_NOT_IMPLEMENTED` | Misleading error -- usually still a bad/unregistered gateway reference, not a missing module | Confirm `mod_sofia` is loaded, then re-check the exact gateway UUID being dialed |
| Outbound fails instantly with `"Timed out waiting for initial communication"`, but manual `fs_cli originate` to the same gateway also fails | No matching Outbound Rule (Caller ID authorization) for this number | Create an Outbound Rule with this number as Caller ID -- see 7.2 |
| Inbound: real page received (confirmed on disk / in RingQ log), but nothing shows up in `GET /fax/jobs` or the Inbox | `domain_uuid` was never set on the channel before the fax actions ran | Add `set(domain_uuid=<value>)` explicitly to that number's dialplan -- see 7.3 rule 1 |
| Dialplan edit confirmed correct in Postgres, but live calls still show the old behavior -- even after `reloadxml` **and** a full `systemctl restart RingQ` | Editing an existing `v_dialplans` row's `dialplan_xml` in place is unreliable on this platform | Disable the old row, insert a fresh one with a brand-new UUID -- see 7.3 rule 3 |
| A previously-working number's dialplan reverts to a generic voice/voicemail flow | RingQ's own DID-assignment UI was touched again for that number, regenerating its own row | Check for a duplicate `v_dialplans` row for that number; disable whichever one isn't yours -- see 7.3 rule 4 |
| Outbound fax connects, `T38 status negotiated`, then fails with `0 pages` after ~30-40s | Real `mod_spandsp` bug on this RingQ build -- stalls after successful T.38 negotiation | Set `fax_enable_t38=false` -- see Section 11 |
| Inbound fails instantly whenever the sending machine has T.38 enabled | That specific machine demands T.38 in the very first SDP answer; RingQ won't offer it that early by default | Disable T.38 on the sending machine -- architectural mismatch, not fixable via our settings (Section 11) |
| `ConnectionRefusedError` / worker log goes quiet after a RingQ restart | Expected -- ESL connection drops when RingQ restarts | Confirm the worker logs `"ESL connection lost -- attempting to reconnect"` followed by a successful reconnect; this is the built-in recovery working correctly, not a failure |
| `ECM status off` / `T38 status off` shown even on a **successful** fax | These fields report what was actually negotiated for that specific call, not the configured setting | Not a bug -- ECM/T.38 are optional and mutually negotiated; a successful fax can complete with either or both off if the far end didn't request them |

---

## 13. Known Limitations

- **No push notifications / webhooks** -- the API is polling-only.
- **No pagination beyond a flat `limit`** on `GET /fax/jobs`.
- **No way to cancel a queued/dialing outbound job.**
- **No way to re-fetch the original uploaded PDF for an outbound job** once queued (its `file_path` gets overwritten with the converted TIFF before dialing).
- **No bulk operations** (bulk send, bulk delete).
- **T.38 is disabled in both directions** -- see Section 11. Audio-only fax is the current, proven-reliable mode.
- **Inbound dialplan setup is still a manual, per-number SQL process** (Section 7.3) -- no UI for it yet. The SQL template there is written to be the direct spec for that future feature, not just a one-off workaround.
