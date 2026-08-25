"""
Multi-tenant HTTP API for the RingQ fax dashboard.

AUTH: validates the caller's existing RingQ session token against
q_tokens (the same table every other RingQ feature already uses) and
resolves domain_uuid from THAT lookup -- never from anything the
request claims about itself. A request with no valid token, or a token
belonging to a different domain than it's trying to act on, is
rejected outright.

The exact header/param RingQ's own frontend sends its token as still
needs confirming against the existing app (checked here in order:
Authorization: Bearer <token>, then X-Access-Token, then a `token`
query param, as the most likely candidates) -- update
_extract_token() below once that's confirmed rather than guessing
further.

Still deliberately free of fax_service.py/greenswitch -- this stays a
pure HTTP + Postgres process; fax_worker.py is the only thing that
talks to FreeSWITCH.
"""
import os
import shutil
import uuid
from typing import Optional

from fastapi import FastAPI, UploadFile, Form, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

import config
import db

app = FastAPI(title="RingQ Fax API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten to the real RingQ portal origin once confirmed
    allow_methods=["*"],
    allow_headers=["*"],
)


def _extract_token(request: Request) -> Optional[str]:
    auth = request.headers.get("Authorization")
    if auth and auth.lower().startswith("bearer "):
        return auth[7:].strip()
    if request.headers.get("X-Access-Token"):
        return request.headers["X-Access-Token"]
    return request.query_params.get("token")


def require_domain(request: Request) -> str:
    token = _extract_token(request)
    if not token:
        raise HTTPException(401, "No RingQ session token found on this request.")
    session = db.authenticate_token(token)
    if not session or not session.get("domain_uuid"):
        raise HTTPException(401, "Invalid or expired RingQ session token.")
    return str(session["domain_uuid"])


class DomainSettingsIn(BaseModel):
    fax_ident: Optional[str] = None
    fax_header: Optional[str] = None


@app.on_event("startup")
def startup():
    db.init_db()
    os.makedirs(config.OUTBOUND_PDF_DIR, exist_ok=True)
    os.makedirs(config.INBOX_PDF_DIR, exist_ok=True)


@app.post("/fax/send")
async def send_fax(request: Request, to_number: str = Form(...), from_number: str = Form(...),
                    file: UploadFile = None):
    domain_uuid = require_domain(request)
    if not file or file.content_type != "application/pdf":
        raise HTTPException(400, "Attach a PDF file.")
    if not to_number.strip() or not from_number.strip():
        raise HTTPException(400, "to_number and from_number are required.")

    # Same check fax_service.py's worker does, just surfaced immediately
    # rather than making the sender wait for the job to fail later.
    did = db.get_did_gateway(domain_uuid, from_number)
    if not did or did["enabled"] != "true":
        raise HTTPException(
            400,
            f"{from_number} isn't a valid number for this account, or has no working gateway assigned.",
        )

    job_id = str(uuid.uuid4())
    pdf_path = os.path.join(config.OUTBOUND_PDF_DIR, f"{job_id}.pdf")
    with open(pdf_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    db.create_job(
        domain_uuid=domain_uuid, direction="out", from_number=from_number,
        to_number=to_number, status="queued", file_path=pdf_path, job_id=job_id,
    )
    return {"job_id": job_id}


@app.get("/fax/jobs")
def list_jobs(request: Request, limit: int = 50):
    domain_uuid = require_domain(request)
    return db.list_jobs(domain_uuid, limit=limit)


@app.get("/fax/jobs/{job_id}")
def get_job(job_id: str, request: Request):
    domain_uuid = require_domain(request)
    job = db.get_job(job_id, domain_uuid=domain_uuid)
    if not job:
        raise HTTPException(404, "Job not found.")
    return job


@app.get("/fax/inbox/{job_id}/file")
def get_inbox_file(job_id: str, request: Request):
    domain_uuid = require_domain(request)
    job = db.get_job(job_id, domain_uuid=domain_uuid)
    if not job or job["direction"] != "in" or job["status"] != "received":
        raise HTTPException(404, "File not available.")
    return FileResponse(job["file_path"], media_type="application/pdf", filename=f"{job_id}.pdf")


@app.get("/fax/dids")
def list_dids(request: Request):
    """Real numbers this account owns that have a working, enabled
    gateway -- the single source for the Send Fax "From" dropdown.
    No separate add/enable step: if it's a real DID with a gateway,
    it's usable."""
    domain_uuid = require_domain(request)
    return db.list_domain_dids(domain_uuid)


@app.get("/fax/settings")
def get_settings(request: Request):
    domain_uuid = require_domain(request)
    settings = db.get_domain_settings(domain_uuid) or {}
    return {
        "fax_ident": settings.get("fax_ident"),
        "fax_header": settings.get("fax_header"),
        "company_name": db.get_company_name(domain_uuid),  # shown as the default if fields above are blank
    }


@app.put("/fax/settings")
def put_settings(body: DomainSettingsIn, request: Request):
    domain_uuid = require_domain(request)
    db.upsert_domain_settings(domain_uuid, fax_ident=body.fax_ident, fax_header=body.fax_header)
    return {"saved": True}
