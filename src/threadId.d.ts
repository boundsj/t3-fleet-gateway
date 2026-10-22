export const MAX_THREAD_ID_CHARS: number;
export function isThreadId(value: unknown): value is string;
export function threadLink(value: unknown): string | null;
export function isThreadLink(value: unknown): boolean;
