import { join } from 'node:path';
import { container } from '@vegapunk/core';
import { waitForConnection } from '@vegapunk/request';
import { isObjectLike, uniqueId } from '@vegapunk/utilities/common';
import SteamUser from 'steam-user';
import SteamCommunity from 'steamcommunity';

import { OfflineStore } from '../stores/OfflineStore';

export class Session {
  public static readonly stores: Map<string, Session> = new Map();

  public static async login(user: UserContext): Promise<void> {
    let session = Session.stores.get(user.username);
    if (isObjectLike(session)) {
      clearTimeout(session.timeout);
      session.timeout = undefined;

      session.logOff();
      Session.stores.delete(user.username);
    }

    await waitForConnection();

    session = new Session(user);
    session.timeout = setTimeout(() => this.login(user), 60_000);
    Session.stores.set(user.username, session);
    await session.logOn();
  }

  public readonly steamID: string;
  public readonly username: string;
  public readonly password: string;
  public readonly secret: string;
  public readonly family: { [k: string]: number };
  public readonly fetchFreeGames: boolean;

  public readonly sessionID: string;
  public readonly web: SteamCommunity;
  public readonly client: SteamUser;
  public readonly stores: OfflineStore<Session>;

  public readonly ownedGameList: GameContext[] = [];
  public readonly blacklistGameIds: number[] = [];
  public readonly whitelistGameIds: number[] = [];

  public enabled = false;
  public playing = false;

  public lastPage = 1;
  public lastLoop = 0;
  public freeGameLength = 0;
  public forceRequest = false;
  public freeGameIds: number[] = [];
  public bannedGameIds: number[] = [];
  public freeGameList: GameContext[] = [];

  public refreshToken?: string;
  public timeout?: NodeJS.Timeout;

  public constructor(user: UserContext) {
    this.steamID = user.id;
    this.username = user.username;
    this.password = user.password;
    this.secret = user.secret;
    this.family = Object.fromEntries((user.family ?? []).map((r) => [r, -1]));
    this.fetchFreeGames = user.fetchFreeGames;

    this.sessionID = uniqueId();
    this.stores = new OfflineStore({
      path: sessionDir(user.username),
      delay: 60_000 * 10,
      watch: async () => {
        return Promise.resolve(this.stores.data);
      },
    });
    this.web = new SteamCommunity({ timeout: 10_000 });
    this.client = new SteamUser({
      dataDirectory: this.stores.dir,
      renewRefreshTokens: true,
      autoRelogin: false,
    });

    this.refreshToken = user.refreshToken;
  }

  public get isExpired(): boolean {
    const session = Session.stores.get(this.username);
    if (!session || session.sessionID !== this.sessionID) return true;
    if (!session.isLogged || !this.isLogged) return true;
    return false;
  }

  public async logOn(): Promise<void> {
    await this.stores.readFile();
    Object.assign(this, this.stores.data);

    this.client.on('webSession', (_: string, cookies: string[]) => this.web.setCookies(cookies));
    container.stores.get('listeners').forEach((ev) => {
      if (ev.emitter !== container.steam) return;

      this.client.on(ev.event as any, (...args: unknown[]) => {
        if (!!this.timeout) {
          clearTimeout(this.timeout);
          this.timeout = undefined;
        }

        if (ev.event === 'loggedOn') {
          this.isLogged = true;
        }

        container.logger.trace(args, `${this.username} stream event ${String(ev.event)}.`);
        container.steam.emit(ev.event, this, ...args);
      });
    });

    const details = { logonID: this.sessionID } as any;
    if (typeof this.refreshToken === 'string') {
      details.refreshToken = this.refreshToken;
      container.logger.info(`${this.username} trying logon using token.`);
    } else {
      details.accountName = this.username;
      details.password = this.password;
      container.logger.info(`${this.username} trying logon using credential.`);
    }

    this.client.logOn(details);
  }

  public logOff(): void {
    this.enabled = false;
    this.isLogged = false;
    this.client.logOff();
    this.stores.dispose();
  }

  private isLogged?: boolean;
}

function sessionDir(username: string) {
  return join(process.cwd(), 'sessions', username, 'session.json');
}

export interface UserContext {
  id: string;
  username: string;
  password: string;
  secret: string;
  family: string[];
  fetchFreeGames: boolean;
  whitelistGameIds: number[];
  blacklistGameIds: number[];
  refreshToken: string | undefined;
}

export interface GameContext {
  name: string;
  appid: number;
}
