import { EventEmitter } from 'node:events';
import { container, Vegapunk } from '@vegapunk/core';
import { waitUntil } from '@vegapunk/utilities/sleep';
import { z } from '@vegapunk/utilities/strict';
import SteamUser, { EResult } from 'steam-user';

import { OnlineStore } from './stores/OnlineStore';
import { Session } from './struct/Session';

import type { UserContext } from './struct/Session';

const EnvSchema = z.object({
  GITHUB_REPO: z.string().min(1),
  GITHUB_OWNER: z.string().min(1),
  GITHUB_PATH: z.string().min(1),
  GITHUB_AUTH: z.string().min(1),
});

export const env = EnvSchema.readonly().parse({
  GITHUB_REPO: process.env.GITHUB_REPO,
  GITHUB_OWNER: process.env.GITHUB_OWNER,
  GITHUB_PATH: process.env.GITHUB_PATH,
  GITHUB_AUTH: process.env.GITHUB_AUTH,
});

export class FamiClient extends Vegapunk {
  public constructor() {
    super();

    const steam = new EventEmitter();
    Object.assign(container, { steam });

    this.onlineStores = new OnlineStore<ConfigContext>({
      repo: env.GITHUB_REPO,
      owner: env.GITHUB_OWNER,
      path: env.GITHUB_PATH,
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
  }

  public override async destroy(): Promise<void> {
    process.exit(1);
  }

  private readonly onlineStores: OnlineStore<ConfigContext>;
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
    disconnected: [session: Session, eresult: SteamUser.EResult, msg: string];
    error: [session: Session, error: Error & { eresult: EResult }];
    loggedOn: [session: Session];
    refreshToken: [session: Session, refreshToken: string];
    steamGuard: [session: Session, domain: string | null, callback: (code: string) => void, lastCodeWrong: boolean];
    vacBans: [session: Session, numBans: number, appids: number[]];
    user: [session: Session, sid: NonNullable<SteamUser['steamID']>, user: Record<string, any>];
  }
}
