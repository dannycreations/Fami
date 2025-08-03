import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseJsonc } from '@vegapunk/utilities';

import { DataStore } from './internal/DataStore';

import type { DataStoreOptions } from './internal/DataStore';

export class OfflineStore<T extends object> extends DataStore<T> {
  public override readonly dir: string;

  public constructor(options: OfflineStoreOptions<T>) {
    super(options);

    this.path = options.path;
    this.dir = dirname(this.path);
  }

  protected async _init(): Promise<void> {
    await access(this.dir).catch(() => mkdir(this.dir, { recursive: true }));
    await access(this.path).catch(() => writeFile(this.path, JSON.stringify(this.options.init)));
  }

  protected async _readFile(): Promise<T | null> {
    return parseJsonc(await readFile(this.path, 'utf8').catch(() => JSON.stringify(this.options.init)));
  }

  protected async _writeFile(): Promise<void> {
    await rename(this.path, `${this.path}.bak`).catch(Boolean);
    await writeFile(this.path, JSON.stringify(this.data));
  }

  private readonly path: string;
}

export interface OfflineStoreOptions<T extends object> extends DataStoreOptions<T> {
  readonly path: string;
}
