import { DAY, HOUR, MINUTE } from '../time.ts';

/** Render rows as aligned columns with a header. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)));
  const line = (cells: readonly string[]) => cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ').trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

export function relative(ms: number): string {
  const abs = Math.abs(ms);
  const amount = abs >= DAY ? `${Math.floor(abs / DAY)}d` : abs >= HOUR ? `${Math.floor(abs / HOUR)}h` : `${Math.max(1, Math.floor(abs / MINUTE))}m`;
  return ms >= 0 ? `in ${amount}` : `${amount} ago`;
}

export function shortTime(ms: number | null): string {
  return ms === null ? '-' : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
