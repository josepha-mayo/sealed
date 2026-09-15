/**
 * Canonical answer form. Both the item author (when hashing the reference answer)
 * and the runner (when hashing a model's reply) go through `canonicalAnswer`, so
 * the only thing that reaches the MPC circuit is a hash of this string.
 *
 * Rules (v1):
 *  - take the text after the last `ANSWER:` marker if present, else the last
 *    non-empty line
 *  - strip markdown emphasis, code fences, surrounding quotes/brackets, trailing '.'
 *  - lowercase, collapse whitespace, drop spaces around commas
 *  - integers: drop '+', thousands separators and leading zeros ("1,024" -> "1024")
 */

const MARKER = /answer\s*:/gi;

export function extractFinal(raw: string): string {
  const text = raw.replace(/\r/g, "");
  let last = -1;
  for (const m of text.matchAll(MARKER)) last = m.index! + m[0].length;
  if (last >= 0) {
    const tail = text.slice(last);
    const firstLine = tail.split("\n").find((l) => l.trim().length > 0);
    return firstLine ?? "";
  }
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

export function normalize(s: string): string {
  let t = s.trim();
  t = t.replace(/^```[a-z]*\s*|\s*```$/g, "");
  t = t.replace(/\*\*|__|`/g, "");
  t = t.trim();
  // strip one layer of wrapping quotes/brackets/parentheses
  const wraps: Array<[string, string]> = [['"', '"'], ["'", "'"], ["(", ")"], ["[", "]"], ["{", "}"]];
  for (const [l, r] of wraps) {
    if (t.length >= 2 && t.startsWith(l) && t.endsWith(r)) {
      t = t.slice(1, -1).trim();
      break;
    }
  }
  t = t.replace(/[.。]+$/g, "").trim();
  t = t.toLowerCase();
  t = t.replace(/\s+/g, " ");
  t = t.replace(/\s*,\s*/g, ",");
  // integer canonicalization
  const intish = t.replace(/[,_\s]/g, "");
  if (/^[+-]?\d+$/.test(intish)) {
    const neg = intish.startsWith("-");
    const digits = intish.replace(/^[+-]/, "").replace(/^0+(?=\d)/, "");
    return digits === "0" ? "0" : (neg ? "-" : "") + digits;
  }
  // coordinate / tuple answers like "3, -2" -> "3,-2" (already handled by comma rule)
  return t;
}

export function canonicalAnswer(raw: string): string {
  return normalize(extractFinal(raw));
}
