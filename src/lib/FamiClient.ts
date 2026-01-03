import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { container, Task, Vegapunk } from '@vegapunk/core';
import { chalk, killApp } from '@vegapunk/utilities';
import { waitUntil } from '@vegapunk/utilities/sleep';
import SteamUser, { EResult } from 'steam-user';

import { OfflineStore } from './stores/OfflineStore';
import { Session } from './struct/Session';

import type { UserContext } from './struct/Session';

export class FamiClient extends Vegapunk {
  public override readonly sessions = new Map<string, Session>();

  private readonly store: OfflineStore<ConfigContext>;

  public constructor() {
    super();

    const steam = new EventEmitter();
    Object.assign(container, { steam } as typeof container);

    this.store = new OfflineStore<ConfigContext>({
      filePath: join(process.cwd(), 'sessions', 'settings.json'),
      init: {
        refreshGames: 3_600_000,
        fetchFreeGames: false,
        skipBannedGames: true,
        whitelistGameIds: [],
        blacklistGameIds: [],
        family: [],
        users: [],
      },
      delay: 60_000,
      watch: () => this.config,
    });
  }

  public override async start(): Promise<void> {
    await super.start();

    await this.store.readFile();
    Object.assign(this, { config: this.store.data });
    this.store.setDelay(this.config.refreshGames);

    await waitUntil(() => !!this.config);
    await Promise.all(this.config.users.map((user) => Session.login(this, user)));

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

  public override updateUser(username: string, data: Partial<UserContext>): void {
    const userIndex = this.config.users.findIndex((user) => user.username === username);
    if (userIndex !== -1) {
      Object.assign(this.config.users[userIndex], data);
    }
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

export interface UserStatus {
  readonly persona_state: number;
  readonly player_name: string;
}

declare module '@vegapunk/core' {
  interface Container {
    readonly steam: EventEmitter;
  }

  interface Vegapunk {
    readonly config: ConfigContext;
    readonly sessions: Map<string, Session>;
    updateUser(username: string, data: Partial<UserContext>): void;
  }

  interface ClientEvents {
    readonly error: [session: Session, error: Error & { eresult: EResult }];
    readonly loggedOn: [session: Session];
    readonly refreshToken: [session: Session, refreshToken: string];
    readonly steamGuard: [session: Session, domain: string | null, callback: (code: string) => void, lastCodeWrong: boolean];
    readonly vacBans: [session: Session, numBans: number, appids: number[]];
    readonly user: [session: Session, sid: NonNullable<SteamUser['steamID']>, user: UserStatus];
  }
}
