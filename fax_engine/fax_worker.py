"""
Standalone worker process. The only process in the whole stack that
talks to FreeSWITCH over ESL -- serves every RingQ customer/domain on
this PBX from one process, since ESL and gevent don't care about
domains, only fax_service.py's own logic does (see its module docstring).

Run under systemd (see ringq-fax-worker.service) so it restarts
automatically on crash and starts on boot.

    python3 fax_worker.py
"""
from gevent import monkey
monkey.patch_all()

import logging

import db
from fax_service import FaxEngine

if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    db.init_db()

    engine = FaxEngine()
    engine.connect()
    logging.getLogger("fax_worker").info("Fax worker running -- waiting for jobs.")
    engine.run_forever()
