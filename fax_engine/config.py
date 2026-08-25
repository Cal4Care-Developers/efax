"""
Central configuration for the multi-tenant RingQ fax engine.

Unlike the single-tenant version, there is no FS_FAX_GATEWAY or FAX_DIDS
here anymore -- which gateway to use and which numbers are fax-enabled
are now per-customer facts looked up from the database (fax_domain_settings
and fax_numbers, both keyed by domain_uuid), not global values baked into
this file. See db.py.
"""
import os


def _load_ringq_config(path):
    """
    Parse RingQ's own flat `key = value` config file. Not a full INI --
    no [sections], just dotted keys, one per line, '#' comments.
    Missing file / missing keys just mean the os.getenv() defaults below
    get used instead.
    """
    values = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip()
    except FileNotFoundError:
        pass
    return values


RINGQ_CONFIG_PATH = os.getenv("RINGQ_CONFIG_PATH", "/etc/ringq/config.conf")
_ringq_conf = _load_ringq_config(RINGQ_CONFIG_PATH)

# --- Database: the SAME Postgres database the rest of the RingQ
# platform uses (both our fax_* tables and FusionPBX's own v_* tables
# live here). Read from config.conf by default; .env can still override
# any individual value if needed for local testing.
DB_HOST = os.getenv("DB_HOST", _ringq_conf.get("database.0.host", "127.0.0.1"))
DB_PORT = int(os.getenv("DB_PORT", _ringq_conf.get("database.0.port", "5432")))
DB_NAME = os.getenv("DB_NAME", _ringq_conf.get("database.0.name", "ringq"))
DB_USER = os.getenv("DB_USER", _ringq_conf.get("database.0.username", "ringq"))
DB_PASSWORD = os.getenv("DB_PASSWORD", _ringq_conf.get("database.0.password", ""))

# --- FreeSWITCH ESL connection ---
# Still global -- one FreeSWITCH instance, one event socket, serving
# every domain/customer on this PBX.
FS_ESL_HOST = os.getenv("FS_ESL_HOST", "127.0.0.1")
FS_ESL_PORT = int(os.getenv("FS_ESL_PORT", "8021"))
FS_ESL_PASSWORD = os.getenv("FS_ESL_PASSWORD", "ClueCon")

# --- File storage ---
# Flat (not per-domain subfolders) -- files are named by unguessable
# UUID job ids, and every API read/write is domain_uuid-checked at the
# database layer (see db.py), which is the actual security boundary.
# Add per-domain subdirectories later if you want defense-in-depth on
# top of that, but it's not required for isolation.
OUTBOUND_PDF_DIR = os.getenv("OUTBOUND_PDF_DIR", "/var/spool/fax/outbound_pdf")
OUTBOUND_TIFF_DIR = os.getenv("OUTBOUND_TIFF_DIR", "/var/spool/fax/outbound_tiff")
INBOUND_TIFF_DIR = os.getenv("INBOUND_TIFF_DIR", "/var/spool/fax/inbound_tiff")
INBOX_PDF_DIR = os.getenv("INBOX_PDF_DIR", "/var/spool/fax/inbox")

# --- Fax quality (global default; per-domain fax_ident/fax_header live
# in fax_domain_settings instead, since those are customer-specific) ---
FAX_RESOLUTION = os.getenv("FAX_RESOLUTION", "204x196")
# Confirmed via direct testing (real page transfer succeeded with this
# off, stalled indefinitely with it on) that this FreeSWITCH/mod_spandsp
# build has a T.38 bug -- negotiates fine, never actually sends/receives
# data afterward. Default OFF until root-caused; flip via .env once
# it's safe to re-enable, no code change needed.
FAX_ENABLE_T38 = os.getenv("FAX_ENABLE_T38", "true").lower() == "true"

# --- Worker timing ---
WORKER_POLL_INTERVAL = float(os.getenv("WORKER_POLL_INTERVAL", "1.5"))
STALE_JOB_TIMEOUT_SECONDS = float(os.getenv("STALE_JOB_TIMEOUT_SECONDS", "180"))
HEARTBEAT_INTERVAL_SECONDS = float(os.getenv("HEARTBEAT_INTERVAL_SECONDS", "30"))
