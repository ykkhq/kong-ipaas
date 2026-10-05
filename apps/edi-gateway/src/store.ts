import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Message payloads on the edi-data volume, one file per message id. */
export class PayloadStore {
  constructor(private dir: string) {}

  private file(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('bad message id');
    return path.join(this.dir, 'messages', `${id}.bin`);
  }

  async put(id: string, data: Buffer): Promise<void> {
    await mkdir(path.join(this.dir, 'messages'), { recursive: true });
    await writeFile(this.file(id), data, { mode: 0o600 });
  }

  get(id: string): Promise<Buffer> {
    return readFile(this.file(id));
  }
}
