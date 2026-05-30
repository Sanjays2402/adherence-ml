"""Redis Queue worker: pulls inference jobs and writes predictions."""
from __future__ import annotations

import redis
from adherence_common.logging import configure_logging, get_logger
from adherence_common.sentry import init_sentry
from adherence_common.settings import get_settings
from rq import Queue, Worker

log = get_logger(__name__)


def make_queue(name: str = "adherence-inference") -> Queue:
    s = get_settings()
    r = redis.from_url(s.redis_url)
    return Queue(name, connection=r)


def run_worker(queue_names: tuple[str, ...] = ("adherence-inference",)) -> None:
    s = get_settings()
    configure_logging(level=s.log_level, fmt=s.log_format)
    init_sentry("adherence-worker")
    r = redis.from_url(s.redis_url)
    qs = [Queue(n, connection=r) for n in queue_names]
    log.info("rq worker starting", queues=list(queue_names))
    Worker(qs, connection=r).work(with_scheduler=False)


if __name__ == "__main__":
    run_worker()
