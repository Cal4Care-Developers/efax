-- Run against the `ringq` database (same one RingQ's own platform uses,
-- per /etc/ringq/config.conf). Safe to re-run -- everything is
-- CREATE ... IF NOT EXISTS.
--
-- If you already created tables based on the old fax_jobs.db (SQLite)
-- schema, drop them first -- that schema has no domain_uuid column and
-- cannot isolate customers from each other:
--   DROP TABLE IF EXISTS fax_jobs, fax_numbers CASCADE;

CREATE TABLE IF NOT EXISTS fax_jobs (
    id UUID PRIMARY KEY,
    domain_uuid UUID NOT NULL,              -- which RingQ customer this belongs to
    direction TEXT NOT NULL,                -- 'in' or 'out'
    from_number TEXT,
    to_number TEXT,
    pages INTEGER DEFAULT 0,
    status TEXT NOT NULL,                   -- queued|dialing|sending|receiving|sent|received|failed
    file_path TEXT,
    call_uuid TEXT,
    esl_job_uuid TEXT,                      -- bgapi Job-UUID, for fast-fail correlation
    error_reason TEXT,
    created_at DOUBLE PRECISION NOT NULL,   -- epoch seconds, same as before
    updated_at DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fax_jobs_domain ON fax_jobs(domain_uuid);
CREATE INDEX IF NOT EXISTS idx_fax_jobs_call_uuid ON fax_jobs(call_uuid);
CREATE INDEX IF NOT EXISTS idx_fax_jobs_esl_job_uuid ON fax_jobs(esl_job_uuid);
-- Speeds up the worker's cross-tenant sweep for queued/stale jobs.
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

-- Per-customer fax identity, used as a fallback when sending -- gateway
-- resolution itself now comes from RingQ's own q_dids + v_gateways
-- (joined by trunk name), not from this table.
CREATE TABLE IF NOT EXISTS fax_domain_settings (
    domain_uuid UUID PRIMARY KEY,
    fax_ident TEXT,
    fax_header TEXT,
    updated_at DOUBLE PRECISION NOT NULL
);
