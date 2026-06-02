"""Tests for ``adherence_common.csv_safe``.

Covers OWASP CSV Injection / CWE-1236 neutralization for the cell-level
helpers used by every CSV exporter (registers, audit, break-glass).
"""
from __future__ import annotations

import csv
import io

import pytest

from adherence_common.csv_safe import safe_cell, safe_row


@pytest.mark.parametrize(
    "raw",
    [
        "=cmd|' /C calc'!A0",
        "=1+1",
        "+1+1",
        "-2+3",
        "@SUM(A1:A9)",
        "\t=1+1",
        "\rfoo",
    ],
)
def test_formula_prefixes_are_neutralized(raw: str) -> None:
    out = safe_cell(raw)
    assert out.startswith("'"), (raw, out)
    # Original characters preserved after the apostrophe.
    assert out[1:] == raw


@pytest.mark.parametrize(
    "raw",
    [
        "regular note",
        "patient-1042",
        "ci-github-actions",
        "covered_entity@acme.example",  # '@' only matters as first char
        "a=b",
        "1+1",
        "x-y-z",
    ],
)
def test_benign_strings_unchanged(raw: str) -> None:
    assert safe_cell(raw) == raw


def test_none_and_booleans() -> None:
    assert safe_cell(None) == ""
    assert safe_cell(True) == "true"
    assert safe_cell(False) == "false"


def test_numbers_passthrough() -> None:
    assert safe_cell(0) == "0"
    assert safe_cell(42) == "42"
    assert safe_cell(3.5) == "3.5"


def test_negative_number_is_neutralized() -> None:
    # A negative number rendered to a CSV cell still hits a formula prefix.
    # Conservative: prepend an apostrophe. Spreadsheets render the number
    # as text but the auditor sees the value, which is the goal for an
    # evidence pack.
    assert safe_cell(-5) == "'-5"


def test_safe_row_applies_to_each_cell() -> None:
    row = safe_row(["ok", "=BAD()", None, 3, True])
    assert row == ["ok", "'=BAD()", "", "3", "true"]


def test_round_trip_through_csv_writer_preserves_neutralization() -> None:
    # Combined with stdlib csv.writer (which only handles RFC 4180 quoting,
    # not formula injection), the cell remains neutralized after parsing.
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(safe_row(["name", "note"]))
    w.writerow(safe_row(["alice", "=HYPERLINK(\"http://evil\",\"click\")"]))
    buf.seek(0)
    rows = list(csv.reader(buf))
    assert rows[0] == ["name", "note"]
    # Parsed cell still starts with apostrophe; spreadsheet will not evaluate.
    assert rows[1][0] == "alice"
    assert rows[1][1].startswith("'=")


def test_empty_string_unchanged() -> None:
    assert safe_cell("") == ""
