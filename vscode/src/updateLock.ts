/** Kernel-owned loopback claim shared by windows; process death releases it without stale-file recovery. */
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';

export async function acquireUpdateLock(namespace: string): Promise<() => Promise<void>> {
  // Scope the port to this host's product-data root. A rare unrelated collision fails closed.
  const port = 30000 + createHash('sha256').update(namespace).digest().readUInt32BE(0) % 10000;
  const server = createServer(socket => { socket.destroy(); });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        server.removeListener('error', reject); resolve();
      });
    });
  } catch (error) {
    server.close();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error('Another window is already updating DSH Companion');
    throw new Error('Could not claim the host update lock');
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); });
  };
}
