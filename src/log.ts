export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, string | number | boolean | null | undefined | readonly string[]>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Field names that could carry a secret or user content. Values under these keys are
 * replaced before a line is written, as a backstop to never passing them at all.
 */
const FORBIDDEN_KEYS = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'code',
  'approvalcode',
  'pairingcode',
  'codeverifier',
  'authorization',
  'credential',
  'secret',
  'password',
  'task',
  'message',
  'text',
  'prompt',
  'content',
]);

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key.toLowerCase().replaceAll(/[_-]/g, ''));
}

export function isLogLevel(value: string): value is LogLevel {
  return Object.hasOwn(LEVELS, value);
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: (line: string) => void;
  clock?: () => number;
}

/** JSON-lines logger. Every line is one object with `time`, `level` and `event`. */
export function createLogger(options: LoggerOptions = {}, bound: LogFields = {}): Logger {
  const threshold = LEVELS[options.level ?? 'info'];
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const clock = options.clock ?? Date.now;

  const write = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    if (LEVELS[level] < threshold) return;
    const record: Record<string, unknown> = { time: new Date(clock()).toISOString(), level, event };
    for (const [key, value] of Object.entries({ ...bound, ...fields })) {
      if (value === undefined) continue;
      record[key] = isForbiddenKey(key) ? '[redacted]' : value;
    }
    sink(JSON.stringify(record));
  };

  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    child: (fields) => createLogger(options, { ...bound, ...fields }),
  };
}

export const silentLogger: Logger = createLogger({ sink: () => {} });
