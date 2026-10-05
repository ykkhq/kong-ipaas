import { mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Per-partner chroot for the hosted SFTP server:
 *   /inbox   partner uploads here (write-only); completed files are received
 *   /outbox  documents we send to the partner (read + delete)
 */
export class PartnerFs {
  readonly root: string;

  constructor(base: string, partnerName: string) {
    this.root = path.join(base, 'sftp', partnerName.replace(/[^\w.-]/g, '_'));
  }

  async init(): Promise<void> {
    for (const d of ['inbox', 'outbox', '.processed']) await mkdir(path.join(this.root, d), { recursive: true });
  }

  /** Sync variant: the SFTP channel must be accepted before the client's INIT arrives. */
  initSync(): void {
    for (const d of ['inbox', 'outbox', '.processed']) mkdirSync(path.join(this.root, d), { recursive: true });
  }

  /** Normalizes a client path to a virtual absolute path, or null if it escapes the root. */
  static normalize(p: string): string | null {
    const v = path.posix.normalize(`/${p || '.'}`);
    if (v.split('/').includes('..')) return null;
    return v === '/.' ? '/' : v.replace(/\/+$/, '') || '/';
  }

  real(virtual: string): string {
    return path.join(this.root, virtual);
  }

  static area(virtual: string): 'root' | 'inbox' | 'outbox' | null {
    if (virtual === '/') return 'root';
    const top = virtual.split('/')[1];
    return top === 'inbox' || top === 'outbox' ? top : null;
  }

  /** Temp names clients use while uploading; completion is their rename. */
  static isTemp(name: string): boolean {
    return name.startsWith('.') || /\.(part|tmp|filepart)$/i.test(name);
  }
}
