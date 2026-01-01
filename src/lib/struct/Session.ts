import { join } from 'node:path';
import { container } from '@vegapunk/core';
import { waitForConnection } from '@vegapunk/request';
import { uniqueId } from '@vegapunk/utilities/common';
import { SetProperty } from '@vegapunk/utilities/decorator';
import { createStore } from '@vegapunk/utilities/strict';
import SteamUser from 'steam-user';
import SteamCommunity from 'steamcommunity';

import { OfflineStore } from '../stores/OfflineStore';

interface SessionState {
  readonly logged: boolean;
  readonly enabled: boolean;
  readonly playing: boolean;

  readonly setLogged: (logged: boolean) => void;
  readonly setEnabled: (enabled: boolean) => void;
  readonly setPlaying: (playing: boolean) => void;
}

export class Session {
  public static async login(user: UserContext): Promise<void> {
    await waitForConnection();

    const existing = Session.sessions.get(user.username);
    if (existing) {
      existing.logOff();
    }

    const session = new Session(user);
    Session.sessions.set(user.username, session);
    await session.logOn();
  }

  private static readonly sessions = new Map<string, Session>();

  @SetProperty(true)
  public readonly steamID: string;
  @SetProperty(true)
  public readonly username: string;
  @SetProperty(true)
  public readonly password: string;
  @SetProperty(true)
  public readonly secret: string;
  public readonly family: { [k: string]: number };
  public readonly fetchFreeGames: boolean;

  public readonly ownedGameList: GameContext[] = [];
  public readonly blacklistGameIds: number[] = [];
  public readonly whitelistGameIds: number[] = [];

  public readonly sessionID: string;
  @SetProperty(true)
  public readonly web: SteamCommunity;
  @SetProperty(true)
  public readonly client: SteamUser;
  @SetProperty(true)
  public readonly store: OfflineStore<SessionData>;
  @SetProperty(true)
  private readonly state = createStore<SessionState>()((set) => ({
    logged: false,
    enabled: false,
    playing: false,

    setLogged: (logged) => {
      set({ logged });
    },
    setEnabled: (enabled) => {
      set({ enabled });
    },
    setPlaying: (playing) => {
      set({ playing });
    },
  }));

  public lastLoop: number = 0;
  public lastPage: number = 1;
  public freeGameIds: number[] = [];
  public freeGameList: GameContext[] = [];
  public freeGameLength: number = 0;
  public forceRegister: boolean = false;
  public bannedGameIds: number[] = [];

  @SetProperty(true)
  public refreshToken?: string;
  private timeout?: NodeJS.Timeout;

  public constructor(user: UserContext) {
    this.steamID = user.id;
    this.username = user.username;
    this.password = user.password;
    this.secret = user.secret;
    this.family = Object.fromEntries((user.family ?? []).map((r) => [r, -1]));
    this.fetchFreeGames = user.fetchFreeGames;
    this.whitelistGameIds = user.whitelistGameIds ?? [];
    this.blacklistGameIds = user.blacklistGameIds ?? [];

    this.sessionID = uniqueId();
    this.store = new OfflineStore({
      filePath: join(process.cwd(), 'sessions', this.username, 'session.json'),
      delay: 60_000 * 10,
      watch: () => ({
        lastLoop: this.lastLoop,
        lastPage: this.lastPage,
        freeGameIds: this.freeGameIds,
        freeGameList: this.freeGameList,
        freeGameLength: this.freeGameLength,
        forceRegister: this.forceRegister,
        ownedGameList: this.ownedGameList,
      }),
    });
    this.web = new SteamCommunity({ timeout: 10_000 });
    this.client = new SteamUser({
      dataDirectory: this.store.dirPath,
      renewRefreshTokens: true,
      autoRelogin: false,
    });

    this.refreshToken = user.refreshToken;

    this.timeout = setTimeout(() => {
      this.logOff();
      Session.login(user);
    }, 60_000);
  }

  public get isEnabled(): boolean {
    return this.state.getState().enabled;
  }

  public get isPlaying(): boolean {
    return this.state.getState().playing;
  }

  public get isExpired(): boolean {
    const { logged } = this.state.getState();
    return !this.timeout && !logged;
  }

  public getState(): SessionState {
    return this.state.getState();
  }

  public async logOn(): Promise<void> {
    await this.store.readFile();
    Object.assign(this, this.store.data);

    this.client.on('webSession', (_: string, cookies: string[]) => {
      this.web.setCookies(cookies);
    });
    container.stores.get('listeners').forEach((ev) => {
      if (!Object.is(ev.emitter, container.steam)) {
        return;
      }

      this.client.on(ev.event as any, (...args: unknown[]) => {
        if (this.isExpired) {
          return;
        }
        if (ev.event === 'loggedOn') {
          this.state.getState().setLogged(true);
        }
        if (this.timeout) {
          clearTimeout(this.timeout);
          this.timeout = undefined;
        }

        container.logger.trace(args, `${this.username} stream event ${String(ev.event)}`);
        container.steam.emit(ev.event, this, ...args);
      });
    });

    if (typeof this.refreshToken === 'string') {
      this.client.logOn({ refreshToken: this.refreshToken });
      container.logger.info(`${this.username} trying logon using token`);
    } else {
      this.client.logOn({ accountName: this.username, password: this.password });
      container.logger.info(`${this.username} trying logon using credential`);
    }
  }

  public logOff(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }

    const { setLogged, setEnabled } = this.state.getState();
    setLogged(false);
    setEnabled(false);

    if (Session.sessions.get(this.username) === this) {
      Session.sessions.delete(this.username);
    }

    this.store.dispose();
    this.client.logOff();
    this.client.removeAllListeners();
    this.web.removeAllListeners();
  }

  public gamesPlayed(ids: number[]): void {
    const hasIds = ids.length > 0;
    if (!hasIds && !this.isPlaying) {
      return;
    }

    this.state.getState().setPlaying(hasIds);

    const { Online, Invisible } = SteamUser.EPersonaState;
    this.client.setPersona(hasIds ? Online : Invisible);
    this.client.gamesPlayed(ids);
  }

  public getExcludedAppIds(): Set<number> {
    const clientConfig = container.client.config;
    return new Set([
      ...clientConfig.blacklistGameIds,
      ...this.blacklistGameIds,
      ...this.bannedGameIds,
      ...this.ownedGameList.map((game) => game.appid),
    ]);
  }

  public getIncludedAppIds(): Set<number> {
    const clientConfig = container.client.config;
    return new Set([...clientConfig.whitelistGameIds, ...this.whitelistGameIds]);
  }
}

export interface SessionData {
  lastLoop: number;
  lastPage: number;
  freeGameIds: number[];
  freeGameList: GameContext[];
  freeGameLength: number;
  forceRegister: boolean;
  ownedGameList: GameContext[];
}

export interface UserContext {
  readonly id: string;
  readonly username: string;
  readonly password: string;
  readonly secret: string;
  readonly family?: string[];
  readonly fetchFreeGames: boolean;
  readonly whitelistGameIds?: number[];
  readonly blacklistGameIds?: number[];
  refreshToken?: string;
}

export interface GameContext {
  readonly name: string;
  readonly appid: number;
}
