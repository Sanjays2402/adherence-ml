"""Static guard: every register CSV export route neutralizes formula injection.

Regression guard for OWASP CSV Injection / CWE-1236. The shared
``adherence_common.csv_safe.safe_row`` helper must wrap the data rows of
every CSV exporter so that auditor-facing exports cannot smuggle
``=HYPERLINK(...)`` / ``@SUM(...)`` payloads through user-controlled
fields (counterparty names, vendor names, justifications, route paths,
model names, error strings).

If a new register adds a CSV export route, append it to ``REGISTER_ROUTES``
below. The test will then fail until the new exporter calls ``safe_row``.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

ROUTES_DIR = Path(__file__).resolve().parents[2] / "services" / "api" / "adherence_api" / "routes"

# Routes that emit CSV register exports. Audit and break-glass route their
# cells through ``safe_cell`` inside a custom escaper, not ``safe_row``; they
# are covered by their own integration tests.
REGISTER_ROUTES = [
    "baa.py",
    "bcdr.py",
    "changes.py",
    "consents.py",
    "disclosures.py",
    "dpia.py",
    "maintenance.py",
    "model_cards.py",
    "pentests.py",
    "risk_register.py",
    "ropa.py",
    "service_accounts.py",
    "sla.py",
    "vendor_risk.py",
]


@pytest.mark.parametrize("filename", REGISTER_ROUTES)
def test_register_route_imports_safe_row(filename: str) -> None:
    src = (ROUTES_DIR / filename).read_text()
    tree = ast.parse(src)
    has_import = any(
        isinstance(node, ast.ImportFrom)
        and node.module == "adherence_common.csv_safe"
        and any(alias.name == "safe_row" for alias in node.names)
        for node in ast.walk(tree)
    )
    assert has_import, (
        f"{filename} writes CSV but does not import safe_row from "
        "adherence_common.csv_safe; user-controlled fields will be evaluated "
        "as formulas when an auditor opens the export in Excel / Google Sheets"
    )


@pytest.mark.parametrize("filename", REGISTER_ROUTES)
def test_register_route_wraps_data_writerow_with_safe_row(filename: str) -> None:
    """The data writerow (the one inside the export loop) must call safe_row.

    We count the number of ``w.writerow(...)`` calls and the number of
    ``w.writerow(safe_row(...))`` calls. There must be at least one data
    writerow and every data writerow must be wrapped. The header writerow
    (static strings) is exempt, so we allow exactly one unwrapped call.
    """
    src = (ROUTES_DIR / filename).read_text()
    tree = ast.parse(src)

    writerow_calls = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "writerow"
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "w"
        ):
            writerow_calls.append(node)

    assert len(writerow_calls) >= 2, (
        f"{filename}: expected header + data writerow, found {len(writerow_calls)}"
    )

    wrapped = 0
    unwrapped = 0
    for call in writerow_calls:
        if not call.args:
            unwrapped += 1
            continue
        arg = call.args[0]
        if (
            isinstance(arg, ast.Call)
            and isinstance(arg.func, ast.Name)
            and arg.func.id == "safe_row"
        ):
            wrapped += 1
        else:
            unwrapped += 1

    assert wrapped >= 1, (
        f"{filename}: no w.writerow(...) call is wrapped with safe_row(); "
        "data rows will not be neutralized against CSV formula injection"
    )
    assert unwrapped <= 1, (
        f"{filename}: {unwrapped} w.writerow(...) calls are NOT wrapped with "
        "safe_row(); only the static header row may be unwrapped"
    )
