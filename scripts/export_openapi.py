"""Export the OpenAPI spec for adherence-ml as JSON.

Used to generate typed clients for Med-Tracker (TS) and other consumers.

Usage:
    uv run python scripts/export_openapi.py > docs/openapi.json
"""
from __future__ import annotations

import json
import logging
import os
import sys

# Provide harmless defaults so the app factory doesn't fail at import time.
os.environ.setdefault("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
os.environ.setdefault("ADHERENCE_JWT_SECRET", "x" * 32)
os.environ.setdefault("ADHERENCE_LOG_LEVEL", "WARNING")

# Force logging to stderr so stdout stays pure JSON.
logging.basicConfig(stream=sys.stderr, level=logging.WARNING, force=True)

from adherence_api.app import create_app  # noqa: E402
from adherence_common.settings import reload_settings  # noqa: E402

reload_settings()
# Re-pin stderr after settings reload reconfigures logging.
for h in list(logging.getLogger().handlers):
    if isinstance(h, logging.StreamHandler):
        h.stream = sys.stderr

app = create_app()
for h in list(logging.getLogger().handlers):
    if isinstance(h, logging.StreamHandler):
        h.stream = sys.stderr

spec = app.openapi()
json.dump(spec, sys.stdout, indent=2, sort_keys=True)
sys.stdout.write("\n")
