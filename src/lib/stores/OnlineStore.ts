import { dirname } from 'node:path';
import { Octokit } from '@octokit/rest';
import { container } from '@vegapunk/core';
import { PartialExcept, strictGet } from '@vegapunk/utilities';
import { isErrorLike } from '@vegapunk/utilities/result';
import { waitUntil } from '@vegapunk/utilities/sleep';

import { DataStore } from './internal/DataStore';

import type { DataStoreOptions } from './internal/DataStore';

export class OnlineStore<T extends object> extends DataStore<T> {
  public override readonly dir: string;

  public constructor(options: OnlineStoreOptions<T>) {
    super(options);

    this.client = new Octokit({ auth: options.auth });

    options.branch ||= 'main';
    this.dir = dirname(`${options.repo}${options.branch}${options.path}`);
  }

  protected async _init(): Promise<void> {
    await this.pull().catch(() => this.writeFile(this.options.init));
  }

  protected async _readFile(): Promise<T | null> {
    return this.pull();
  }

  protected async _writeFile(): Promise<void> {
    await this.push({ content: JSON.stringify(this.data, null, 2) });
  }

  private async pull<T>(options: Partial<PullContext> = {}): Promise<T | null> {
    options = { ...this.options, ...options };
    const key = `${options.branch}/${options.path}`;

    return new Promise(async (resolve) => {
      await waitUntil(async () => {
        try {
          const { data } = await this.client.repos.getContent({
            owner: options.owner!,
            repo: options.repo!,
            ref: options.branch!,
            path: options.path!,
          });

          this.shaCache.set(key, strictGet(data, 'sha'));

          const content = String(Buffer.from(strictGet(data, 'content'), 'base64'));
          return (resolve(JSON.parse(content) as T), true);
        } catch (error) {
          if (isErrorLike<{ status: number }>(error)) {
            if (!!~error.message.indexOf('timeout')) {
              container.logger.error(`Github pull: ${error.status} ${error.message}.`);
              return false;
            }

            container.logger.error(error, `Github pull: ${error.status} ${error.message}.`);
          }
          return (resolve(null), true);
        }
      });
    });
  }

  private async push(options: PartialExcept<PushContext, 'content'>): Promise<boolean> {
    options = { ...this.options, ...options };
    const key = `${options.branch}/${options.path}`;

    return new Promise(async (resolve) => {
      await waitUntil(async () => {
        try {
          let sha = this.shaCache.get(key)!;
          if (typeof sha !== 'string') {
            await this.pull(options);
            sha = this.shaCache.get(key)!;
          }

          const { data } = await this.client.repos.createOrUpdateFileContents({
            owner: options.owner!,
            repo: options.repo!,
            ref: options.branch!,
            path: options.path!,
            content: Buffer.from(options.content).toString('base64'),
            message: options.message || 'from_server',
            sha,
          });

          this.shaCache.set(key, strictGet(data, 'content.sha'));
          return (resolve(true), true);
        } catch (error) {
          if (isErrorLike<{ status: number }>(error)) {
            if (!!~error.message.indexOf('timeout')) {
              container.logger.error(`Github push: ${error.status} ${error.message}.`);
              return false;
            }

            container.logger.error(error, `Github push: ${error.status} ${error.message}.`);
          }
          return (resolve(false), true);
        }
      });
    });
  }

  private readonly shaCache: Map<string, string> = new Map();
  private readonly client: Octokit;
}

export type OnlineStoreOptions<T extends object> = DataStoreOptions<T> & PullContext & { auth: string };

export interface PullContext {
  owner: string;
  repo: string;
  branch?: string;
  path: string;
}

export interface PushContext extends PullContext {
  content: string;
  message?: string;
}
