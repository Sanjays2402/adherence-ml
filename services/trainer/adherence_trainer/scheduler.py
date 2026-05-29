"""APScheduler-based training scheduler (nightly retrain)."""
from __future__ import annotations

import signal
import time

from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger

from adherence_common.logging import configure_logging, get_logger
from adherence_common.settings import get_settings
from adherence_trainer.pipeline import run_training

log = get_logger(__name__)


def _job() -> None:
    log.info("scheduled training start")
    try:
        out = run_training(synthetic=True, users=2000, days=45, register_as="nightly")
        log.info("scheduled training done", **{"metrics." + k: v for k, v in out["metrics"].items()})
    except Exception as exc:
        log.exception("scheduled training failed", error=str(exc))


def main(cron_expr: str = "0 3 * * *") -> None:
    s = get_settings()
    configure_logging(level=s.log_level, fmt=s.log_format)
    sched = BlockingScheduler(timezone="UTC")
    sched.add_job(_job, CronTrigger.from_crontab(cron_expr), id="nightly-train")
    log.info("scheduler started", cron=cron_expr)

    def _stop(*_):
        log.info("scheduler stopping")
        sched.shutdown(wait=False)
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    try:
        sched.start()
    except (KeyboardInterrupt, SystemExit):
        pass
    log.info("scheduler exited")
    time.sleep(0.1)


if __name__ == "__main__":
    main()
