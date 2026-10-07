/** The part of a process output stream the CLI uses. */
export interface OutputStream {
  write(text: string): unknown;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
}

/**
 * A line writer for stdout or stderr that tolerates a reader going away. When the other end of a
 * pipe closes (`t3-fleet-gateway pair | head -1`), Node reports EPIPE as an 'error' event, which
 * would crash the process with a stack trace. Once that happens, nothing more can be shown, so later
 * lines are dropped and the command finishes with its own exit code. Any other stream error is
 * rethrown as before.
 */
export function lineWriter(stream: OutputStream): (text: string) => void {
  let closed = false;
  stream.on('error', (error) => {
    if (error.code === 'EPIPE' || (closed && error.code === 'ERR_STREAM_DESTROYED')) {
      closed = true;
      return;
    }
    throw error;
  });
  return (text) => {
    if (!closed) stream.write(`${text}\n`);
  };
}
