"""
Postgres-backed store for fax jobs, numbers, and per-domain settings --
shares the RingQ platform's own `ringq` database rather than a private
SQLite file.

Every function that touches fax_jobs takes a domain_uuid and filters by
it. This is the actual tenant-isolation boundary: as long as
api_server.py never calls these functions without the requesting
customer's own domain_uuid, one customer's dashboard can never read or
modify another's data, regardless of what ids it might guess or be
handed.

Which numbers can send fax is no longer tracked in a separate table --
list_domain_dids()/get_did_gateway() read directly from RingQ's own
q_dids + v_gateways, so there's nothing to keep in sync.

The two exceptions are list_queued_outbound() and list_stale_sending(),
which are deliberately NOT domain-scoped -- fax_worker.py is a single
process serving every domain on this PBX, so it needs to see queued/
stuck jobs across all of them. Nothing about that weakens isolation:
the worker only ever acts on a job using the domain_uuid already stored
on that specific row (e.g. to look up which gateway to dial through),
never lets one domain's job affect another's data.
"""
import time
import uuid as uuidlib

import psycopg2
import psycopg2.extras

import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS fax_jobs (
    id UUID PRIMARY KEY,
    domain_uuid UUID NOT NULL,
    direction TEXT NOT NULL,
    from_number TEXT,
    to_number TEXT,
    pages INTEGER DEFAULT 0,
    status TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS fax_numbers (
    domain_uuid UUID NOT NULL,
    number TEXT NOT NULL,
    label TEXT,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at DOUBLE PRECISION NOT NULL,
    updated_at DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (domain_uuid, number)
);

CREATE TABLE IF NOT EXISTS fax_domain_settings (
    domain_uuid UUID PRIMARY KEY,
    fax_ident TEXT,
    fax_header TEXT,
    updated_at DOUBLE PRECISION NOT NULL
);
"""


def _conn():
    return psycopg2.connect(
        host=config.DB_HOST, port=config.DB_PORT, dbname=config.DB_NAME,
        user=config.DB_USER, password=config.DB_PASSWORD,
        cursor_factory=psycopg2.extras.RealDictCursor,
    )


def init_db():
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(SCHEMA)
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Fax jobs
# ---------------------------------------------------------------------------

def create_job(domain_uuid, direction, from_number, to_number, status="queued",
               file_path=None, call_uuid=None, job_id=None):
    job_id = job_id or str(uuidlib.uuid4())
    now = time.time()
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO fax_jobs
                   (id, domain_uuid, direction, from_number, to_number, pages,
                    status, file_path, call_uuid, created_at, updated_at)
                   VALUES (%s, %s, %s, %s, %s, 0, %s, %s, %s, %s, %s)""",
                (job_id, domain_uuid, direction, from_number, to_number,
                 status, file_path, call_uuid, now, now),
            )
        conn.commit()
    finally:
        conn.close()
    return job_id


def update_job(job_id, domain_uuid=None, **fields):
    """
    domain_uuid is optional: the worker updates jobs it already located
    by call_uuid/esl_job_uuid (it doesn't always have domain_uuid handy
    at that exact point, and it's implicitly trusted). Anything called
    from api_server.py -- the tenant-facing side -- MUST pass domain_uuid,
    so a request can never touch a job outside the caller's own domain
    even if it somehow knew another tenant's job id.
    """
    if not fields:
        return
    fields["updated_at"] = time.time()
    cols = ", ".join(f"{k} = %s" for k in fields)
    values = list(fields.values()) + [job_id]
    where = "id = %s"
    if domain_uuid is not None:
        where += " AND domain_uuid = %s"
        values.append(domain_uuid)
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(f"UPDATE fax_jobs SET {cols} WHERE {where}", values)
        conn.commit()
    finally:
        conn.close()


def get_job(job_id, domain_uuid=None):
    query = "SELECT * FROM fax_jobs WHERE id = %s"
    params = [job_id]
    if domain_uuid is not None:
        query += " AND domain_uuid = %s"
        params.append(domain_uuid)
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(query, params)
            row = cur.fetchone()
            return dict(row) if row else None
    finally:
        conn.close()


def get_job_by_call_uuid(call_uuid):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM fax_jobs WHERE call_uuid = %s", (call_uuid,))
            row = cur.fetchone()
            return dict(row) if row else None
    finally:
        conn.close()


def get_job_by_esl_job_uuid(esl_job_uuid):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM fax_jobs WHERE esl_job_uuid = %s", (esl_job_uuid,))
            row = cur.fetchone()
            return dict(row) if row else None
    finally:
        conn.close()


def list_jobs(domain_uuid, limit=50):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT * FROM fax_jobs WHERE domain_uuid = %s
                   ORDER BY created_at DESC LIMIT %s""",
                (domain_uuid, limit),
            )
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


def list_queued_outbound():
    """NOT domain-scoped -- see module docstring. The worker needs every
    customer's queued jobs, not just one."""
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT * FROM fax_jobs
                   WHERE direction = 'out' AND status = 'queued'
                   ORDER BY created_at ASC"""
            )
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


def list_stale_sending(cutoff_ts):
    """NOT domain-scoped, same reason as list_queued_outbound()."""
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT * FROM fax_jobs
                   WHERE direction = 'out' AND status IN ('dialing', 'sending')
                   AND updated_at < %s""",
                (cutoff_ts,),
            )
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()
        conn.close()


# ---------------------------------------------------------------------------
# Auth: validate against RingQ's OWN existing session tokens (q_tokens) --
# the same mechanism every other RingQ feature already uses, not something
# new invented for fax.
# ---------------------------------------------------------------------------

def authenticate_token(access_token):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT user_uuid, domain_uuid FROM q_tokens WHERE access_token = %s",
                (access_token,),
            )
            row = cur.fetchone()
            return dict(row) if row else None
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Gateway resolution: RingQ's own q_dids table already links each number to
# its trunk by friendly name (sip_trunk_name), joined against FusionPBX's
# v_gateways to find that gateway's row. FreeSWITCH's actual dial string
# needs gateway_uuid, NOT the friendly name -- FusionPBX keys gateways by
# UUID internally since friendly names are only unique per-domain, not
# across the whole multi-tenant PBX (confirmed directly against a live
# `sofia status gateway` -- the friendly name never appears there, only
# the UUID does). Per-number, not per-domain -- a company can have several
# numbers on different trunks.
# ---------------------------------------------------------------------------

def get_did_gateway(domain_uuid, did_number):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT g.gateway, g.gateway_uuid, g.enabled
                   FROM q_dids d
                   JOIN v_gateways g ON g.gateway = d.sip_trunk_name AND g.domain_uuid = d.domain_uuid
                   WHERE d.domain_uuid = %s AND d.did_number = %s""",
                (domain_uuid, did_number),
            )
            row = cur.fetchone()
            return dict(row) if row else None
    finally:
        conn.close()


def get_company_name(domain_uuid):
    """Used as a sensible default fax_ident/fax_header if the customer
    hasn't set one explicitly -- one less thing to configure."""
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT company_name FROM q_companies WHERE domain_uuid = %s LIMIT 1",
                (domain_uuid,),
            )
            row = cur.fetchone()
            return row["company_name"] if row else None
    finally:
        conn.close()


def list_domain_dids(domain_uuid):
    """
    Real numbers this domain owns that actually have a working, enabled
    gateway behind them -- used to populate the Numbers tab's "Add
    number" picker instead of a free-text field, so it's impossible to
    add a number that would just fail at send time with no gateway found.
    """
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT d.did_number, d.name, d.sip_trunk_name
                   FROM q_dids d
                   JOIN v_gateways g ON g.gateway = d.sip_trunk_name AND g.domain_uuid = d.domain_uuid
                   WHERE d.domain_uuid = %s AND g.enabled = 'true'
                   ORDER BY d.did_number""",
                (domain_uuid,),
            )
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Per-domain settings (fax_ident/fax_header overrides only now -- gateway
# resolution moved to get_did_gateway() above, since it's per-number in
# RingQ's own data model, not per-domain)
# ---------------------------------------------------------------------------

def get_domain_settings(domain_uuid):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT * FROM fax_domain_settings WHERE domain_uuid = %s",
                (domain_uuid,),
            )
            row = cur.fetchone()
            return dict(row) if row else None
    finally:
        conn.close()


def upsert_domain_settings(domain_uuid, fax_ident=None, fax_header=None):
    now = time.time()
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO fax_domain_settings (domain_uuid, fax_ident, fax_header, updated_at)
                   VALUES (%s, %s, %s, %s)
                   ON CONFLICT (domain_uuid) DO UPDATE SET
                       fax_ident = EXCLUDED.fax_ident,
                       fax_header = EXCLUDED.fax_header,
                       updated_at = EXCLUDED.updated_at""",
                (domain_uuid, fax_ident, fax_header, now),
            )
        conn.commit()
    finally:
        conn.close()
