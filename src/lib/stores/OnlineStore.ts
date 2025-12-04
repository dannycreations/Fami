import { Octokit } from '@octokit/rest';
import { container } from '@vegapunk/core';
import { strictGet } from '@vegapunk/utilities';
import { isErrorLike } from '@vegapunk/utilities/result';
import { waitUntil } from '@vegapunk/utilities/sleep';

import { DataStore } from './internal/DataStore';

import type { DataStoreOptions } from './internal/DataStore';

export class OnlineStore<T extends object> extends DataStore<T, PullOptions> {
  private readonly client: Octokit;
  private readonly shaCache: Map<string, string> = new Map();

  public constructor(options: OnlineStoreOptions<T>) {
    options.ref = options.ref || 'main';

    super({
      ...options,
      filePath: `${options.repo}/${options.ref}/${options.file}`,
    });

    this.client = new Octokit({ auth: options.auth });
  }

  protected async _init(): Promise<void> {
    await this.pull().catch(() => {
      return this.writeFile(this.options.init);
    });
  }

  protected async _readFile(): Promise<T | null> {
    return this.pull();
  }

  protected async _writeFile(): Promise<void> {
    await this.push();
  }

  private async pull(): Promise<T | null> {
    return new Promise((resolve) =>
      waitUntil(async () => {
        try {
          const { data } = await this.client.repos.getContent({
            owner: this.options.owner,
            repo: this.options.repo,
            ref: this.options.ref,
            path: this.options.file,
          });

          this.shaCache.set(this.filePath, strictGet(data, 'sha'));

          const content = String(Buffer.from(strictGet(data, 'content'), 'base64'));
          resolve(JSON.parse(content) as T);
          return true;
        } catch (error) {
          if (isErrorLike<{ status: number }>(error)) {
            if (error.message.includes('timeout')) {
              container.logger.error(`Github pull: ${error.status} ${error.message}.`);
              return false;
            }

            container.logger.error(error, `Github pull: ${error.status} ${error.message}.`);
          }

          resolve(null);
          return true;
        }
      }),
    );
  }

  private async push(): Promise<boolean> {
    return new Promise((resolve) =>
      waitUntil(async () => {
        try {
          let sha = this.shaCache.get(this.filePath);
          if (typeof sha !== 'string') {
            await this.pull();
            sha = this.shaCache.get(this.filePath);
          }

          const content = JSON.stringify(this.data, null, 2);
          const { data } = await this.client.repos.createOrUpdateFileContents({
            owner: this.options.owner,
            repo: this.options.repo,
            ref: this.options.ref,
            path: this.options.file,
            content: Buffer.from(content).toString('base64'),
            message: 'from_server',
            sha,
          });

          this.shaCache.set(this.filePath, strictGet(data, 'content.sha'));
          resolve(true);
          return true;
        } catch (error) {
          if (isErrorLike<{ status: number }>(error)) {
            if (error.message.includes('timeout')) {
              container.logger.error(`Github push: ${error.status} ${error.message}.`);
              return false;
            }

            container.logger.error(error, `Github push: ${error.status} ${error.message}.`);
          }

          resolve(false);
          return true;
        }
      }),
    );
  }
}

interface OnlineStoreOptions<T extends object> extends Partial<DataStoreOptions<T>>, PullOptions {
  auth: string;
}

interface PullOptions {
  owner: string;
  repo: string;
  ref?: string;
  file: string;
}
