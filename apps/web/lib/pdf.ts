// Minimal zero-dependency PDF 1.4 generator. Single page, single Helvetica
// font, sufficient for adherence run summary reports. Intentionally small so we
// avoid pulling a headless browser or a 1MB+ pdf library into the bundle.
//
// Layout uses points (72 pt = 1 inch). Letter page = 612 x 792.

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_X = 54;
const TOP_Y = 750; // first baseline from page top

/** Escape a string for inclusion inside a PDF text-show literal. */
function pdfEscape(s: string): string {
  // Drop non-ASCII; the standard 14 fonts only ship WinAnsi. Anything fancier
  // would need a TTF subset and CMap which is out of scope for a tiny report.
  return s
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/** Width of a string at a given font size in Helvetica points. */
function stringWidth(s: string, size: number): number {
  // Rough Helvetica average advance width 0.5 em; good enough for wrap math.
  return s.length * size * 0.5;
}

/** Greedy word-wrap into lines that fit within maxWidth points. */
function wrap(text: string, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    if (!para.trim()) {
      out.push("");
      continue;
    }
    const words = para.split(/\s+/);
    let line = "";
    for (const w of words) {
      const trial = line ? `${line} ${w}` : w;
      if (stringWidth(trial, size) <= maxWidth) {
        line = trial;
      } else {
        if (line) out.push(line);
        // hard-break extra long single tokens
        if (stringWidth(w, size) > maxWidth) {
          let chunk = "";
          for (const ch of w) {
            if (stringWidth(chunk + ch, size) > maxWidth) {
              out.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          line = chunk;
        } else {
          line = w;
        }
      }
    }
    if (line) out.push(line);
  }
  return out;
}

export type PdfBlock =
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "p"; text: string }
  | { kind: "mono"; text: string }
  | { kind: "rule" }
  | { kind: "space"; pts?: number };

/**
 * Build the page content stream and return raw bytes.
 * Lays blocks out top-down. Anything that would overflow the page is dropped
 * gracefully (single-page report by design).
 */
function buildContentStream(blocks: PdfBlock[]): string {
  const ops: string[] = [];
  let y = TOP_Y;
  const usableW = PAGE_W - MARGIN_X * 2;

  const writeLines = (
    lines: string[],
    size: number,
    leading: number,
    font: "F1" | "F2",
  ) => {
    if (!lines.length) return;
    ops.push("BT");
    ops.push(`/${font} ${size} Tf`);
    ops.push(`${leading} TL`);
    ops.push(`1 0 0 1 ${MARGIN_X} ${y} Tm`);
    for (let i = 0; i < lines.length; i++) {
      if (y < 54) break;
      if (i === 0) {
        ops.push(`(${pdfEscape(lines[i])}) Tj`);
      } else {
        ops.push(`T*`);
        ops.push(`(${pdfEscape(lines[i])}) Tj`);
      }
      y -= leading;
    }
    ops.push("ET");
  };

  for (const b of blocks) {
    if (y < 60) break;
    if (b.kind === "space") {
      y -= b.pts ?? 8;
      continue;
    }
    if (b.kind === "rule") {
      ops.push("0.85 0.85 0.85 RG");
      ops.push("0.5 w");
      ops.push(`${MARGIN_X} ${y + 4} m ${PAGE_W - MARGIN_X} ${y + 4} l S`);
      y -= 10;
      continue;
    }
    if (b.kind === "h1") {
      const lines = wrap(b.text, 20, usableW);
      writeLines(lines, 20, 24, "F2");
      y -= 6;
      continue;
    }
    if (b.kind === "h2") {
      const lines = wrap(b.text, 12, usableW);
      writeLines(lines, 12, 16, "F2");
      y -= 2;
      continue;
    }
    if (b.kind === "p") {
      const lines = wrap(b.text, 11, usableW);
      writeLines(lines, 11, 14, "F1");
      y -= 2;
      continue;
    }
    if (b.kind === "mono") {
      const lines = wrap(b.text, 9, usableW);
      writeLines(lines, 9, 11, "F1");
      y -= 2;
      continue;
    }
  }

  return ops.join("\n") + "\n";
}

/**
 * Compose a full PDF document from an array of blocks. Returns a Buffer
 * suitable for sending as a NextResponse body.
 */
export function renderPdf(blocks: PdfBlock[]): Buffer {
  const content = buildContentStream(blocks);
  const contentBytes = Buffer.from(content, "latin1");

  // PDF objects. We hand-roll a tiny cross-reference table.
  const objects: string[] = [];
  const push = (body: string) => {
    objects.push(body);
    return objects.length; // 1-based object id
  };

  const catalogId = push("<< /Type /Catalog /Pages 2 0 R >>");
  push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"); // id 2
  push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`,
  ); // id 3
  push(
    `<< /Length ${contentBytes.length} >>\nstream\n${content}endstream`,
  ); // id 4
  push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"); // id 5
  push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"); // id 6

  // Assemble byte stream and capture each object offset for the xref table.
  const header = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  let body = "";
  const offsets: number[] = [];
  let cursor = Buffer.byteLength(header, "latin1");
  objects.forEach((o, i) => {
    offsets.push(cursor);
    const chunk = `${i + 1} 0 obj\n${o}\nendobj\n`;
    body += chunk;
    cursor += Buffer.byteLength(chunk, "latin1");
  });

  const xrefStart = cursor;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${off.toString().padStart(10, "0")} 00000 n \n`;
  }
  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.concat([
    Buffer.from(header, "latin1"),
    Buffer.from(body, "latin1"),
    Buffer.from(xref, "latin1"),
    Buffer.from(trailer, "latin1"),
  ]);
}
