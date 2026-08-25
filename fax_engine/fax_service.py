"""
Core fax engine library, multi-tenant version. Wraps a greenswitch ESL
connection to FreeSWITCH -- one connection serves every RingQ customer
on this PBX, since ESL itself has no concept of domains (that's a
FusionPBX/application-layer idea, not a FreeSWITCH core one).

This module is imported by fax_worker.py, which is the only process
that should run it -- keep api_server.py free of this import so the
web process never touches gevent/ESL directly.

Responsibilities:
  1. Poll the DB for outbound jobs ANY domain's api_server.py queued,
     resolve that job's OWN domain's gateway (from fax_domain_settings),
     convert PDF -> TIFF, and originate the call.
  2. Detect inbound fax calls on any domain's fax DID, determine which
     domain it belongs to (FusionPBX already sets this on the channel),
     and create a job scoped to that domain.
  3. On CHANNEL_HANGUP_COMPLETE for any fax call, finalize the job.

Correlation strategy: unchanged from the single-tenant version --
fax_job_id / esl_job_uuid for outbound, call_uuid for inbound. See the
single-tenant version's history for how each of these was arrived at;
the only new piece here is resolving domain_uuid -> gateway per job
instead of using one global gateway for everyone.

Depends on the dialplan actions (fax_direction=in, fax_file=..., etc.)
being installed per-domain in FusionPBX -- see FUSIONPBX_SETUP.md.
FusionPBX's own global dialplan already exports domain_uuid onto every
inbound channel before our domain-specific actions run, so we don't
need to set that ourselves -- just read it off the event.
"""
import logging
import os
import re
import time

import gevent
import greenswitch
from greenswitch.esl import NotConnectedError

import config
import db
from converters import ConversionError, pdf_to_tiff, tiff_to_pdf

log = logging.getLogger("fax_service")


def _extract_bgapi_result(event):
    """
    greenswitch doesn't expose a BACKGROUND_JOB event's raw API result
    text through any documented attribute. Empirically (confirmed from
    real production output, not the library's docs), it ends up
    appended onto whatever header the parser happened to be on last --
    observed landing inside 'Content-Length'. Scanning every header
    value for a '+OK'/'-ERR' line rather than hardcoding that one key
    keeps this working if a different header absorbs it next time.
    """
    candidates = [getattr(event, "data", None), getattr(event, "body", None)]
    candidates.extend(event.headers.values())
    for value in candidates:
        if not value:
            continue
        for line in str(value).splitlines():
            line = line.strip()
            if line.startswith("+OK") or line.startswith("-ERR"):
                return line
    return None


def _fs_var(value):
    """
    Wrap a channel-variable value in single quotes if it contains
    characters (spaces, commas) that would otherwise break FreeSWITCH's
    {key=value,...} origination parsing -- this is what silently broke
    every outbound send for a while before it was caught: fax_header's
    default value has a space in it and was going in unquoted.
    """
    value = str(value)
    if any(c in value for c in " ,"):
        return f"'{value}'"
    return value


class FaxEngine:
    def __init__(self):
        self.esl = None
        self._last_heartbeat = 0

    # ------------------------------------------------------------------
    # Connection / event loop
    # ------------------------------------------------------------------

    def connect(self):
        self.esl = greenswitch.InboundESL(
            host=config.FS_ESL_HOST,
            port=config.FS_ESL_PORT,
            password=config.FS_ESL_PASSWORD,
        )
        self.esl.connect()
        self.esl.register_handle("CHANNEL_ANSWER", self._on_channel_answer)
        self.esl.register_handle("CHANNEL_HANGUP_COMPLETE", self._on_hangup_complete)
        self.esl.register_handle("BACKGROUND_JOB", self._on_background_job)
        self.esl.send("events plain CHANNEL_ANSWER CHANNEL_HANGUP_COMPLETE BACKGROUND_JOB")
        log.info("Connected to FreeSWITCH ESL at %s:%s", config.FS_ESL_HOST, config.FS_ESL_PORT)

    def run_forever(self):
        while True:
            try:
                self._heartbeat()
                self._poll_outbound_queue()
                self._fail_stale_jobs()
            except NotConnectedError:
                log.warning("ESL connection lost -- attempting to reconnect")
                try:
                    self.connect()
                except Exception:
                    log.exception("Reconnect attempt failed, will retry next cycle")
            except Exception:
                log.exception("Error in worker loop")
            try:
                gevent.sleep(config.WORKER_POLL_INTERVAL)
            except KeyboardInterrupt:
                self.esl.stop()
                break

    def _heartbeat(self):
        now = time.time()
        if now - self._last_heartbeat < config.HEARTBEAT_INTERVAL_SECONDS:
            return
        self._last_heartbeat = now
        self.esl.send("api status")

    # ------------------------------------------------------------------
    # Outbound: pick up jobs any domain's api_server.py queued
    # ------------------------------------------------------------------

    def _poll_outbound_queue(self):
        for job in db.list_queued_outbound():
            db.update_job(job["id"], status="dialing")
            try:
                self._originate_fax(job)
            except NotConnectedError:
                db.update_job(job["id"], status="failed",
                               error_reason="Lost connection to FreeSWITCH while dialing")
                raise

    def _originate_fax(self, job):
        job_id = job["id"]
        domain_uuid = job["domain_uuid"]
        to_number = job["to_number"]
        from_number = job["from_number"]
        pdf_path = job["file_path"]

        settings = db.get_domain_settings(domain_uuid) or {}
        did = db.get_did_gateway(domain_uuid, from_number)
        if not did or did["enabled"] != "true":
            db.update_job(job_id, status="failed",
                           error_reason=f"No enabled gateway found for {from_number} (check its trunk assignment in RingQ)")
            log.warning("Job %s: no usable gateway for DID %s in domain %s", job_id, from_number, domain_uuid)
            return
        # FreeSWITCH's dial string needs the internal gateway_uuid, not the
        # friendly "gateway" display name -- FusionPBX keys gateways by
        # UUID under the hood precisely because friendly names are only
        # unique per-domain, not across the whole multi-tenant PBX.
        gateway_id = did["gateway_uuid"]
        company_name = db.get_company_name(domain_uuid)
        fax_ident = settings.get("fax_ident") or company_name or "Fax"
        fax_header = settings.get("fax_header") or company_name or "Fax"

        log.info("Job %s: dialing %s -> %s via gateway %s (%s) (domain %s)",
                  job_id, from_number, to_number, did["gateway"], gateway_id, domain_uuid)

        os.makedirs(config.OUTBOUND_TIFF_DIR, exist_ok=True)
        tiff_path = os.path.join(config.OUTBOUND_TIFF_DIR, f"{job_id}.tiff")

        try:
            pdf_to_tiff(pdf_path, tiff_path)
        except ConversionError as e:
            db.update_job(job_id, status="failed", error_reason=str(e))
            log.error("Job %s: PDF->TIFF conversion failed: %s", job_id, e)
            return

        db.update_job(job_id, file_path=tiff_path)

        # NOTE: fax_ident/fax_header MUST go through _fs_var() -- an
        # unescaped space in either breaks FreeSWITCH's {key=value,...}
        # parser entirely and silently kills the whole origination.
        origination_vars = (
            f"origination_caller_id_number={from_number},"
            f"fax_job_id={job_id},"
            f"fax_direction=out,"
            f"fax_enable_t38={'true' if config.FAX_ENABLE_T38 else 'false'},"
            f"fax_enable_ecm=true,"
            f"fax_verbose=true,"
            f"fax_ident={_fs_var(fax_ident)},"
            f"fax_header={_fs_var(fax_header)},"
            f"ignore_early_media=true"
        )
        dial_string = f"{{{origination_vars}}}sofia/gateway/{gateway_id}/{to_number}"
        originate_cmd = f"bgapi originate {dial_string} &txfax({tiff_path})"

        result = self.esl.send(originate_cmd)
        result_text = result.data.strip() if result and result.data else ""
        log.info("Job %s: originate sent -> %s", job_id, result_text)

        match = re.search(r"Job-UUID:\s*([0-9a-fA-F-]{36})", result_text)
        esl_job_uuid = match.group(1) if match else None
        db.update_job(job_id, status="sending", esl_job_uuid=esl_job_uuid)

    def _on_background_job(self, event):
        """
        Fails a job immediately on a confirmed -ERR result. Deliberately
        does nothing on '+OK' or an unrecognized result -- CHANNEL_HANGUP_
        COMPLETE and _fail_stale_jobs remain the source of truth for
        anything this doesn't confidently recognize.
        """
        esl_job_uuid = event.headers.get("Job-UUID")
        if not esl_job_uuid:
            return
        job = db.get_job_by_esl_job_uuid(esl_job_uuid)
        if not job or job["status"] != "sending":
            return

        result_line = _extract_bgapi_result(event)
        log.info("Job %s: BACKGROUND_JOB result=%s", job["id"], result_line)

        if result_line and result_line.startswith("-ERR"):
            db.update_job(job["id"], status="failed", error_reason=result_line)
            log.warning("Job %s: origination failed before a channel was created: %s", job["id"], result_line)

    def _fail_stale_jobs(self):
        cutoff = time.time() - config.STALE_JOB_TIMEOUT_SECONDS
        for job in db.list_stale_sending(cutoff):
            db.update_job(job["id"], status="failed",
                           error_reason="Timed out waiting for a call result from FreeSWITCH")
            log.warning("Job %s: marked failed after exceeding %ss with no result",
                        job["id"], config.STALE_JOB_TIMEOUT_SECONDS)

    # ------------------------------------------------------------------
    # Inbound: call answered on a fax DID, any domain
    # ------------------------------------------------------------------

    def _on_channel_answer(self, event):
        headers = event.headers
        direction = headers.get("variable_fax_direction")
        if direction != "in":
            return

        call_uuid = headers.get("Unique-ID")
        from_number = headers.get("Caller-Caller-ID-Number", "unknown")
        to_number = headers.get("Caller-Destination-Number", "unknown")
        # FusionPBX's own global dialplan already exports domain_uuid
        # onto the channel before our per-domain fax actions run -- we
        # just read it back rather than trying to work it out ourselves.
        domain_uuid = headers.get("variable_domain_uuid")
        tiff_path = headers.get("variable_fax_file") or os.path.join(
            config.INBOUND_TIFF_DIR, f"{call_uuid}.tiff"
        )

        if not domain_uuid:
            log.warning("Inbound fax call %s has no domain_uuid on the channel -- "
                        "check that the dialplan actions run after FusionPBX's own "
                        "domain-variables entry, not before it. Skipping.", call_uuid)
            return

        os.makedirs(config.INBOUND_TIFF_DIR, exist_ok=True)

        job_id = db.create_job(
            domain_uuid=domain_uuid,
            direction="in",
            from_number=from_number,
            to_number=to_number,
            status="receiving",
            file_path=tiff_path,
            call_uuid=call_uuid,
        )
        log.info("Inbound fax call %s -> job %s (domain %s, %s -> %s)",
                  call_uuid, job_id, domain_uuid, from_number, to_number)

    # ------------------------------------------------------------------
    # Both directions: call ended, read the result
    # ------------------------------------------------------------------

    def _on_hangup_complete(self, event):
        headers = event.headers
        direction = headers.get("variable_fax_direction")
        if direction not in ("in", "out"):
            return

        call_uuid = headers.get("Unique-ID")
        job_id = headers.get("variable_fax_job_id")
        job = db.get_job(job_id) if job_id else db.get_job_by_call_uuid(call_uuid)

        if not job:
            log.warning("Hangup for fax call %s but no matching job found", call_uuid)
            return

        fax_success = headers.get("variable_fax_success") == "1"
        result_text = headers.get("variable_fax_result_text", "")
        pages = int(headers.get("variable_fax_document_transferred_pages", 0) or 0)

        if direction == "out":
            status = "sent" if fax_success else "failed"
            db.update_job(job["id"], status=status, pages=pages,
                           error_reason=None if fax_success else result_text,
                           call_uuid=call_uuid)
            log.info("Job %s (out) finished: %s, %s pages, %s", job["id"], status, pages, result_text)
            return

        if not fax_success:
            db.update_job(job["id"], status="failed", pages=pages, error_reason=result_text)
            log.info("Job %s (in) failed: %s", job["id"], result_text)
            return

        os.makedirs(config.INBOX_PDF_DIR, exist_ok=True)
        pdf_path = os.path.join(config.INBOX_PDF_DIR, f"{job['id']}.pdf")
        try:
            tiff_to_pdf(job["file_path"], pdf_path)
            db.update_job(job["id"], status="received", pages=pages, file_path=pdf_path)
            log.info("Job %s (in) received: %s pages -> %s", job["id"], pages, pdf_path)
        except ConversionError as e:
            db.update_job(job["id"], status="failed", pages=pages, error_reason=str(e))
            log.error("Job %s (in) TIFF->PDF conversion failed: %s", job["id"], e)
