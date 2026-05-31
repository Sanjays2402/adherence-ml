/**
 * Smoke test for lib/csv.ts.
 * Run with:  pnpm tsx lib/__tests__/csv.test.ts
 * No test runner required; exits non-zero on failure.
 */

import { parseCsv, toCsv } from "../csv";

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}
function eq(a: unknown, b: unknown, msg: string) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg}\n  got: ${JSON.stringify(a)}\n  exp: ${JSON.stringify(b)}`);
}

// 1. Basic header + rows
{
  const { header, rows } = parseCsv("a,b,c\n1,2,3\n4,5,6\n");
  eq(header, ["a", "b", "c"], "basic header");
  eq(rows, [["1", "2", "3"], ["4", "5", "6"]], "basic rows");
}

// 2. Quoted fields with commas and escaped quotes
{
  const { rows } = parseCsv('a,b\n"hello, world","she said ""hi"""\n');
  eq(rows, [["hello, world", 'she said "hi"']], "quoted fields");
}

// 3. CRLF line endings + BOM
{
  const { header, rows } = parseCsv("\uFEFFa,b\r\n1,2\r\n");
  eq(header, ["a", "b"], "BOM stripped");
  eq(rows, [["1", "2"]], "CRLF rows");
}

// 4. Empty trailing lines ignored
{
  const { rows } = parseCsv("a,b\n1,2\n\n\n");
  eq(rows, [["1", "2"]], "trailing blanks");
}

// 5. Missing trailing newline
{
  const { rows } = parseCsv("a,b\n1,2");
  eq(rows, [["1", "2"]], "no trailing newline");
}

// 6. toCsv round-trip with special chars
{
  const out = toCsv(["x", "y"], [["a,b", 'q"q'], ["", null]]);
  eq(out, '"x","y"\n"a,b","q""q"\n,\n'.replace('"x","y"', "x,y"), "csv round-trip");
  const back = parseCsv(out);
  eq(back.header, ["x", "y"], "round-trip header");
  eq(back.rows, [["a,b", 'q"q'], ["", ""]], "round-trip rows");
}

console.log("ok lib/csv.ts");
