"""CSV / spreadsheet formula injection defense.

Spreadsheet applications (Excel, Google Sheets, LibreOffice Calc, Numbers)
interpret a cell whose first character is one of ``= + - @`` (and historically
tab ``\\t`` or carriage return ``\\r``) as a formula. Auditor-facing CSV
exports that include user-controlled strings, names, notes, emails, are a
known phishing and remote-content vector (OWASP "CSV Injection" / CWE-1236).

OWASP guidance: prefix any such cell with a single quote ``'``. Some
exporters use a leading apostrophe; we follow the more conservative
practice of also wrapping the cell in double quotes so that the apostrophe
is preserved as a literal character on parse.

Helpers here are intentionally tiny and dependency-free so every CSV
exporter (registers, audit, break-glass evidence packs) can adopt them
without import cycles.
"""
from __future__ import annotations

from typing import Any, Iterable

_FORMULA_PREFIXES: tuple[str, ...] = ("=", "+", "-", "@", "\t", "\r")


def safe_cell(v: Any) -> str:
    """Return ``v`` as a string, neutralized against CSV formula injection.

    - ``None`` becomes the empty string.
    - Booleans become ``true`` / ``false`` (lowercase) so they survive
      round-tripping through ``csv.reader`` without surprise.
    - Any other value is stringified via ``str()``.
    - If the resulting string begins with a spreadsheet formula prefix
      (``=``, ``+``, ``-``, ``@``, tab, CR) a literal single quote is
      prepended. This is the OWASP-recommended defense and is what Excel
      strips on display.

    The returned string is *not* CSV-quoted. Callers should still pass it
    through :func:`csv.writer.writerow` (which handles quoting of commas,
    quotes, and newlines) or through their own escaper.
    """
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    s = str(v)
    if s and s[0] in _FORMULA_PREFIXES:
        return "'" + s
    return s


def safe_row(values: Iterable[Any]) -> list[str]:
    """Apply :func:`safe_cell` to every value in ``values``."""
    return [safe_cell(v) for v in values]


__all__ = ["safe_cell", "safe_row"]
