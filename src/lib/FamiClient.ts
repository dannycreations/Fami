import { EventEmitter } from 'node:events';
import { container, Task, Vegapunk } from '@vegapunk/core';
import { chalk, killApp } from '@vegapunk/utilities';
import { waitUntil } from '@vegapunk/utilities/sleep';
import { v } from '@vegapunk/utilities/strict';
import SteamUser, { EResult } from 'steam-user';

import { OnlineStore } from './stores/OnlineStore';
import { Session } from './struct/Session';

import type { UserContext } from './struct/Session';

export const env = v.parse(
  v.pipe(
    v.object({
      GITHUB_REPO: v.pipe(v.string(), v.minLength(1)),
      GITHUB_OWNER: v.pipe(v.string(), v.minLength(1)),
      GITHUB_FILE: v.pipe(v.string(), v.minLength(1)),
      GITHUB_AUTH: v.pipe(v.string(), v.minLength(1)),
    }),
    v.readonly(),
  ),
  process.env,
);

export class FamiClient extends Vegapunk {
  private readonly onlineStores: OnlineStore<ConfigContext>;

  public constructor() {
    super();

    const steam = new EventEmitter();
    Object.assign(container, { steam } as typeof container);

    this.onlineStores = new OnlineStore<ConfigContext>({
      repo: env.GITHUB_REPO,
      owner: env.GITHUB_OWNER,
      file: env.GITHUB_FILE,
      auth: env.GITHUB_AUTH,
      init: { blacklistGameIds: [], whitelistGameIds: [] },
      delay: 60_000,
      watch: () => this.config,
    });
  }

  public override async start(): Promise<void> {
    await super.start();

    await this.onlineStores.readFile();
    Object.assign(this, { config: this.onlineStores.data });
    this.onlineStores.setDelay(this.config.refreshGames);

    await waitUntil(() => !!this.config);
    await Promise.all(this.config.users.map(Session.login));

    let lastCheckedDay: number | undefined = undefined;
    await Task.createTask({
      update: () => {
        const currentDay = new Date().getDate();
        if (lastCheckedDay === undefined) {
          lastCheckedDay = currentDay;
          return;
        }
        if (currentDay === lastCheckedDay) {
          return;
        }

        lastCheckedDay = currentDay;
        container.logger.info(chalk`{bold.yellow It's midnight time. Restarting app...}`);
        container.client.destroy();
      },
      options: { name: 'midnight', delay: 10_000 },
    });
  }

  public override async destroy(): Promise<void> {
    super.destroy();
    killApp();
  }
}

export interface ConfigContext {
  refreshGames: number;
  fetchFreeGames: boolean;
  skipBannedGames: boolean;
  whitelistGameIds: number[];
  blacklistGameIds: number[];
  family: string[];
  users: UserContext[];
}

declare module '@vegapunk/core' {
  interface Container {
    readonly steam: EventEmitter;
  }

  interface Vegapunk {
    readonly config: ConfigContext;
  }

  interface ClientEvents {
    error: [session: Session, error: Error & { eresult: EResult }];
    loggedOn: [session: Session];
    refreshToken: [session: Session, refreshToken: string];
    steamGuard: [session: Session, domain: string | null, callback: (code: string) => void, lastCodeWrong: boolean];
    vacBans: [session: Session, numBans: number, appids: number[]];
    user: [session: Session, sid: NonNullable<SteamUser['steamID']>, user: Record<string, any>];
  }
}
