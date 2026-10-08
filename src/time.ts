/** Milliseconds since the epoch. Injected so tests can move time. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const UNITS: Record<string, number> = { s: SECOND, m: MINUTE, h: HOUR, d: DAY, y: 365 * DAY };

/** Parse durations like `90s`, `15m`, `2h`, `1d`, `1y` (365 days). Returns undefined when malformed. */
export function parseDuration(text: string): number | undefined {
  const match = /^(\d{1,6})([smhdy])$/.exec(text.trim());
  if (!match) return undefined;
  const unit = UNITS[match[2] ?? ''];
  return unit === undefined ? undefined : Number(match[1]) * unit;
}

export function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}
