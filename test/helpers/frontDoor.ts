import { connect, createServer, type Socket } from 'node:net';
import type { TestContext } from 'node:test';

/**
 * A loopback TCP forwarder that holds one port for the whole test. The gateway listens on a port
 * of its own (picked by the OS) behind it, so a restarted gateway keeps the same public URL without
 * releasing a port and binding it again, which another test process could take in between. With no
 * target when a connection's first request arrives, the connection is reset.
 */
export interface FrontDoor {
  url: string;
  port: number;
  /** The loopback port connections are forwarded to. */
  target: number | undefined;
}

export async function openFrontDoor(t: TestContext): Promise<FrontDoor> {
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  };
  const door: FrontDoor = { url: '', port: 0, target: undefined };
  const server = createServer((client) => {
    track(client);
    client.on('error', () => client.destroy());
    // Forward or reset once the request arrives, not on accept: see the Invariants in AGENTS.md.
    client.once('data', (first: Buffer) => {
      if (door.target === undefined) return void client.resetAndDestroy();
      client.pause();
      const upstream = connect(door.target, '127.0.0.1');
      track(upstream);
      upstream.write(first);
      client.pipe(upstream).pipe(client);
      for (const [from, to] of [
        [client, upstream],
        [upstream, client],
      ] as const) {
        from.on('error', () => to.destroy());
        from.on('close', () => to.destroy());
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  door.port = (server.address() as { port: number }).port;
  door.url = `http://127.0.0.1:${door.port}`;
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return door;
}
