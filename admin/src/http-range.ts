/**
 * Single-range HTTP `Range` header parsing (RFC 9110 §14) for the attachment
 * proxy. Pure — no I/O. Multi-range, malformed and non-`bytes` requests are
 * ignored (`none`), which the caller answers with a normal 200.
 */
export type ByteRange =
  | { kind: "none" }
  | { kind: "range"; start: number; end: number }
  | { kind: "unsatisfiable" };

export function parseByteRange(
  header: string | null | undefined,
  size: number,
): ByteRange {
  if (!header) return { kind: "none" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return { kind: "none" };

  if (m[1] === "") {
    // Suffix: the last n bytes.
    const n = Number(m[2]);
    if (n === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "range", start: Math.max(0, size - n), end: size - 1 };
  }

  const start = Number(m[1]);
  if (m[2] !== "" && Number(m[2]) < start) return { kind: "none" };
  if (start >= size) return { kind: "unsatisfiable" };
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  return { kind: "range", start, end };
}
