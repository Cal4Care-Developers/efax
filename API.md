# RingQ Fax API — Reference

Verified directly against the current production source (`api_server.py`, `db.py`, `fax_service.py`) rather than written from memory — every status value, field name, and edge case below reflects what the code actually does today.

---

## Base URL & Authentication

```
Base URL: https://<ringq-domain>/fax-api
```

Every endpoint requires a valid RingQ session token, sent as a Bearer token:

```
Authorization: Bearer <access_token>
```

Alternatively (checked in this order): `X-Access-Token` header, or a `?token=` query parameter — the latter is required for the file-download endpoint, since browser navigation can't set custom headers.

**How auth works:** the token is looked up directly in RingQ's own `q_tokens` table (the same table every other RingQ feature uses — nothing fax-specific). Whatever `domain_uuid` that token belongs to is the tenant every request is scoped to. There is no separate login for fax — if the user is already logged into RingQ, their existing token works here too.

- Missing token → `401 No RingQ session token found on this request.`
- Invalid/expired token → `401 Invalid or expired RingQ session token.`

**Tenant isolation**: every job is scoped to the `domain_uuid` resolved from the token. A request can never read or modify another domain's jobs, even if it somehow knew another domain's job ID — enforced at the database query level, not just the API layer.

---

## Endpoints

### `POST /fax/send` — Send an outbound fax

**Request:** `multipart/form-data`

| Field | Type | Required | Notes |
|---|---|---|---|
| `to_number` | string | yes | Destination fax number |
| `from_number` | string | yes | Must be a real number for this domain with a working gateway — see `GET /fax/dids` |
| `file` | file | yes | Must be `application/pdf` — no other type accepted |

**Response `200`:**
```json
{ "job_id": "b1526f46-c427-4fcd-bcbb-80bfb8f60f4b" }
```

**Errors:**
- `400` — missing/wrong file type, missing fields, or `from_number` has no valid gateway (checked immediately, before the job is even created — fails fast rather than making the sender wait and poll for a doomed job)
- `401` — auth failure (see above)

**What happens after `200`:** the job is created with `status: "queued"`. It does **not** send synchronously — see the status lifecycle below, and poll `GET /fax/jobs/{job_id}` for progress.

---

### `GET /fax/jobs?limit=50` — List jobs for this domain

Returns every job (both directions) for the authenticated domain, most recent first.

**Response `200`:** array of job objects (see **Job Object** below).

This is the endpoint to poll for an Inbox / activity list. There is **no websocket or push mechanism** — polling is the only real-time option currently. The reference dashboard polls this every 4 seconds for the Overview/Status Log/Inbox views.

---

### `GET /fax/jobs/{job_id}` — Get a single job

**Response `200`:** one job object, or `404` if it doesn't exist (or belongs to a different domain — indistinguishable from the caller's perspective, by design).

**Recommended pattern for tracking one active send in real time** (this is exactly what the reference dashboard does): after `POST /fax/send` returns a `job_id`, poll this endpoint every ~1.2 seconds until `status` reaches a terminal value (`sent` or `failed`), then stop.

---

### `GET /fax/inbox/{job_id}/file` — Download/view a received fax

Returns the PDF file directly (`Content-Type: application/pdf`).

**Only works when `direction == "in"` AND `status == "received"`** — anything else (still `receiving`, or `failed`) returns `404 File not available.` There's no way to fetch a partial/failed inbound fax's file.

For `<a href>`-style links (browser navigation, downloads) rather than `fetch()`, pass the token as a query param instead of a header, since links can't carry custom headers:
```
GET /fax/inbox/{job_id}/file?token=<access_token>
```

**Known gap worth knowing about:** there's currently no equivalent endpoint to fetch the *originally uploaded* PDF for an outbound job — once a send is queued, its `file_path` gets overwritten with the converted TIFF path before dialing (see **Job Object** notes below). If your UI needs to show "what was sent," you'd need to keep a copy client-side at upload time.

---

### `GET /fax/dids` — List numbers available to send from

Returns every real number on this domain that has a working, enabled gateway — the correct source for a "From" picker. There's no separate enable/disable step; if a number has a real trunk assignment in RingQ, it's usable.

**Response `200`:**
```json
[
  { "did_number": "63401023", "name": "InboundFax RIngQ", "sip_trunk_name": "calncalltrunk2" },
  { "did_number": "13462090806", "name": "Ravichandran Vijay", "sip_trunk_name": "calncalltrunk2" }
]
```
Note: `name` is unreliable as a display label — it gets silently overwritten by RingQ's own extension-assignment UI (confirmed in testing) and often ends up showing a person's name rather than anything fax-related. **Use `sip_trunk_name` for display**, not `name`.

---

### `GET /fax/settings` — Get this domain's fax header/ident

**Response `200`:**
```json
{
  "fax_ident": "Acme Corp",
  "fax_header": "Acme Corp",
  "company_name": "Acme Corp"
}
```
`fax_ident`/`fax_header` are `null` if never explicitly set — `company_name` is what's actually used as the default in that case (pulled from RingQ's own `q_companies`), shown here so a UI can display "will use: X" instead of a blank field.

### `PUT /fax/settings` — Update fax header/ident

**Request body:**
```json
{ "fax_ident": "Acme Corp", "fax_header": "Acme Corp" }
```
Either field can be `null`/omitted to fall back to the company name default. **Response `200`:** `{ "saved": true }`

---

## Job Object

Returned by `GET /fax/jobs`, `GET /fax/jobs/{job_id}`, and as the shape of every item in the list endpoint. This is the literal `fax_jobs` table row.

```json
{
  "id": "b1526f46-c427-4fcd-bcbb-80bfb8f60f4b",
  "domain_uuid": "f3aa95ce-24ff-4248-9242-2c29fc739b1f",
  "direction": "out",
  "from_number": "63401023",
  "to_number": "13462090806",
  "pages": 1,
  "status": "sent",
  "file_path": "/var/spool/fax/outbound_tiff/b1526f46-....tiff",
  "call_uuid": "edd10be0-e932-4b67-aad6-c32dd03047f2",
  "esl_job_uuid": "3fec60a0-0aac-4de8-a5e6-8776acc46998",
  "error_reason": null,
  "created_at": 1786644644.606,
  "updated_at": 1786644750.049
}
```

| Field | Notes |
|---|---|
| `direction` | `"out"` or `"in"` |
| `pages` | `0` until the call actually completes; final count set at hangup |
| `file_path` | **Direction-dependent meaning — see below** |
| `call_uuid` | RingQ channel UUID. Set immediately for inbound; only populated for outbound once the channel actually exists (may be `null` while `status: "sending"` if the call hasn't connected yet) |
| `esl_job_uuid` | Outbound only — correlates the async `originate` command to its result |
| `error_reason` | Human-readable failure detail, `null` on success/in-progress. This is the exact text worth surfacing in a UI — see the failed-fax detail popup in the reference dashboard for the pattern |
| `created_at` / `updated_at` | Unix epoch seconds (not ms) |

**`file_path` is not stable in meaning — it changes as the job progresses**:
- **Outbound**: starts as the uploaded PDF path at creation, then gets **overwritten with the converted TIFF path** right before dialing. By the time `status` is `sending` or later, `file_path` points at the TIFF, not the original PDF.
- **Inbound**: starts as the TIFF path (`INBOUND_TIFF_DIR/{call_uuid}.tiff`) while `status: "receiving"`, then gets **overwritten with the converted PDF path** once received successfully. This is the same path served by `GET /fax/inbox/{job_id}/file`.

Don't rely on `file_path`'s value meaning the same thing across a job's lifetime — treat it as an internal implementation detail rather than something to expose directly, and use the dedicated `/fax/inbox/{job_id}/file` endpoint for actually fetching a received fax.

---

## Status Lifecycle

### Outbound (`direction: "out"`)

```
queued -> dialing -> sending -> sent
                             -> failed
                    -> failed          (gateway/conversion failure, never reaches "sending")
         -> failed                     (stale timeout, no result within 180s)
```

| Status | Meaning |
|---|---|
| `queued` | Job created via `POST /fax/send`, not yet picked up by the worker |
| `dialing` | Worker has claimed the job, resolving gateway / converting PDF->TIFF |
| `sending` | `originate` command sent to RingQ, `esl_job_uuid` now set — call is live |
| `sent` | Completed successfully — `pages` reflects the real transferred count |
| `failed` | See `error_reason` for why — common causes below |

**Ways a job can reach `failed`, and what `error_reason` looks like for each:**
- No valid gateway for `from_number` -- *(usually caught synchronously at `POST /fax/send` as a `400` instead, but can also happen here if the gateway becomes unavailable between validation and dialing)*
- PDF->TIFF conversion error -- the conversion error message directly
- RingQ rejects the call before a channel is even created (bad gateway, immediate reject) -- the raw `-ERR ...` line from RingQ, e.g. `-ERR INVALID_GATEWAY`
- No result from RingQ within 180 seconds -- `"Timed out waiting for a call result from RingQ"`
- Call connected but fax negotiation failed -- RingQ's own T.30 result text, e.g. `"The call dropped prematurely"`, `"Timed out waiting for the first message"`

### Inbound (`direction: "in"`)

```
receiving -> received
          -> failed
```

Notably **shorter** than outbound — there's no `queued`/`dialing` equivalent, since an inbound job doesn't exist at all until the call is already answered.

| Status | Meaning |
|---|---|
| `receiving` | Call answered on a fax DID, job just created — call is actively in progress |
| `received` | Fax completed successfully, TIFF converted to PDF, file ready at `GET /fax/inbox/{job_id}/file` |
| `failed` | Call ended without a successful fax — see `error_reason` |

**Important edge case, worth knowing about explicitly**: if FusionPBX's dialplan doesn't have `domain_uuid` correctly set on the channel before the fax actions run, **no job gets created at all** — the call may complete a real, successful fax transfer, but nothing will ever show up in `GET /fax/jobs` for it, since there's no domain to attach it to. This isn't an API-level failure a UI can detect or poll for — it's a dialplan configuration issue. If a real fax was received on a customer's line but never appears in this UI, that's the first thing worth checking (not a bug in the polling logic).

---

## Recommended patterns for a new UI

### Live "Inbox" / activity feed
Poll `GET /fax/jobs?limit=N` on an interval (4 seconds is what the reference dashboard uses — frequent enough to feel real-time, not aggressive enough to be wasteful). Diff against the previous result client-side if you want smooth UI updates rather than a full re-render.

### Live status while actively sending
1. `POST /fax/send` -> get `job_id`
2. Poll `GET /fax/jobs/{job_id}` every ~1.2s
3. Stop polling once `status` is `sent` or `failed`
4. Map `status` directly to a progress indicator: `queued` -> `dialing` -> `sending` -> `sent`/`failed` reads naturally as a 4-step progress UI (this is literally what the reference dashboard's "Transmission status" panel does)

### Showing a receiving-fax indicator
Since inbound jobs appear the instant the call is answered (`status: "receiving"`), a UI polling the jobs list will pick this up in real time as a new row — no special handling needed beyond normal list polling. There's no separate "someone is calling" pre-job state to display; the first sign of an inbound fax *is* the `receiving` job appearing.

### Failed-fax detail
Surface `error_reason` directly — it's already written to be human-readable (RingQ's own T.30 result text, or a clear message from our own validation). The reference dashboard shows this as a small icon next to the "Failed" status pill that opens a popup with the full text on click.

---

## Things this API does *not* currently do

Worth knowing before designing around them:
- **No webhooks or push notifications** — polling only.
- **No pagination beyond `limit`** — `GET /fax/jobs` takes a flat limit, no cursor/offset.
- **No way to cancel a queued/dialing job.**
- **No way to re-fetch the original uploaded PDF for an outbound job** once queued (see `file_path` notes above).
- **No bulk operations** (bulk send, bulk delete, etc.).
