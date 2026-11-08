export interface HorizonCursor {
  original: string;
  primary: bigint;
  secondary: bigint;
}

export function parseHorizonCursor(value: string): HorizonCursor | null {
  if (typeof value !== "string" || value.length > 128) {
    return null;
  }
  const match = /^(\d+)(?:-(\d+))?$/.exec(value);
  if (!match) {
    return null;
  }
  try {
    return {
      original: value,
      primary: BigInt(match[1] ?? "0"),
      secondary: BigInt(match[2] ?? "0"),
    };
  } catch {
    return null;
  }
}

export function compareHorizonCursors(left: string, right: string): number | null {
  const a = parseHorizonCursor(left);
  const b = parseHorizonCursor(right);
  if (!a || !b) {
    return null;
  }
  if (a.primary !== b.primary) {
    return a.primary < b.primary ? -1 : 1;
  }
  if (a.secondary !== b.secondary) {
    return a.secondary < b.secondary ? -1 : 1;
  }
  return 0;
}
