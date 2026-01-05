import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { parseJsonc } from '@vegapunk/utilities';

import { DataStore } from './internal/DataStore';

export class OfflineStore<T extends object> extends DataStore<T> {
  protected async _init(): Promise<void> {
    await access(this.dirPath).catch(() => {
      return mkdir(this.dirPath, { recursive: true });
    });
    await access(this.filePath).catch(() => {
      return writeFile(this.filePath, JSON.stringify(this.options.init));
    });
  }

  protected async _readFile(): Promise<T | null> {
    const readData = await readFile(this.filePath, 'utf8').catch(() => {
      return JSON.stringify(this.options.init);
    });
    return parseJsonc(readData);
  }

  protected async _writeFile(): Promise<void> {
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(this.data));
    await rename(this.filePath, `${this.filePath}.bak`).catch(Boolean);
    await rename(tempPath, this.filePath);
  }
}
