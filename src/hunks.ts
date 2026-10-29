export interface Hunk { oldStart: number; oldLines: number; text: string }

export function splitHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const line of patch.split("\n")) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (m) {
      cur = { oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), text: line };
      hunks.push(cur);
    } else if (cur) cur.text += "\n" + line;
  }
  return hunks;
}

/** Hunk whose old-side range contains the commented line, else the closest hunk, else null. */
export function pickHunk(patch: string, line: number | null): Hunk | null {
  const hunks = splitHunks(patch);
  if (!hunks.length) return null;
  if (line == null) return hunks[0];
  const dist = (h: Hunk) => line < h.oldStart ? h.oldStart - line : Math.max(0, line - (h.oldStart + h.oldLines - 1));
  return hunks.reduce((best, h) => (dist(h) < dist(best) ? h : best));
}
