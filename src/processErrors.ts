import type { Logger } from './log.ts';

/** How long `serve` waits for a graceful shutdown after a fatal process error before giving up on it. */
export const FATAL_SHUTDOWN_MS = 10_000;

/**
 * Node 26.0's bundled undici sets the socket's type of service when it writes a request from the
 * socket's `connect` handler. When the peer has already reset the new connection (T3 restarting),
 * macOS refuses that with EINVAL, and the throw escapes as an uncaught exception instead of failing
 * the request; the request itself then fails with an ordinary connection reset. Nothing was written,
 * and the process is otherwise unharmed.
 */
export function isTypeOfServiceRace(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { syscall, code } = error as { syscall?: unknown; code?: unknown };
  return syscall === 'setTypeOfService' && code === 'EINVAL';
}

export interface ProcessGuard {
  /** Resolves on the first fatal error: the caller shuts down and exits non-zero. */
  fatal: Promise<void>;
  remove(): void;
}

/**
 * Handle uncaught exceptions and unhandled rejections for a long-running command. The undici race
 * above is logged and ignored; anything else is logged by name and code only (a message could carry
 * request content) and resolves `fatal`, so the process stops and its supervisor restarts it.
 */
export function guardProcess(logger: Logger): ProcessGuard {
  const fatal = Promise.withResolvers<void>();
  const handle = (origin: 'uncaughtException' | 'unhandledRejection') => (error: unknown) => {
    if (isTypeOfServiceRace(error)) {
      logger.warn('process.transient_socket_error', { origin, syscall: 'setTypeOfService', errorCode: 'EINVAL' });
      return;
    }
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    logger.error('process.fatal', {
      origin,
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: typeof code === 'string' || typeof code === 'number' ? code : undefined,
    });
    fatal.resolve();
  };
  const onException = handle('uncaughtException');
  const onRejection = handle('unhandledRejection');
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);
  return {
    fatal: fatal.promise,
    remove: () => {
      process.off('uncaughtException', onException);
      process.off('unhandledRejection', onRejection);
    },
  };
}
