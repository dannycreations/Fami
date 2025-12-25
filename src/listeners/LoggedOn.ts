import { container, Listener, Task } from '@vegapunk/core';
import { requestDefault } from '@vegapunk/request';
import { Mutex } from '@vegapunk/struct';
import { chalk } from '@vegapunk/utilities';
import { random, remove, shuffle, unionBy } from '@vegapunk/utilities/common';
import { isErrorLike, Result } from '@vegapunk/utilities/result';
import { sleep, waitForEach, waitUntil } from '@vegapunk/utilities/sleep';
import { humanizeDuration } from '@vegapunk/utilities/time';
import SteamUser from 'steam-user';

import { getSteamUser } from '../lib/helpers/common.helper';
import { Session } from '../lib/struct/Session';
import { AppDetails } from '../lib/types/AppDetails';

import type { GameContext } from '../lib/struct/Session';

const KEY_TASK_IDLER = (key: string, type: 'MAIN' | 'SIDE'): string => `${key}_${type}_IDLER`;
const TIMEOUT_MESSAGE = 'Request timed out' as const;
const EXCLUDED_GAME_NAME = /\b(?:Beta|Demo|P(?:laytest|TS)|Public (?:Beta|Test)|Test|Unstable)\b/i;

export class LoggedOnListener extends Listener<'loggedOn'> {
  public constructor(context: Listener.LoaderContext) {
    super(context, {
      emitter: container.steam,
      event: 'loggedOn',
    });
  }

  public async run(session: Session): Promise<void> {
    const clientConfig = this.container.client.config;
    const userConfig = clientConfig.users.find((user) => user.username === session.username)!;
    Object.assign(userConfig, { id: session.client.steamID!.toString() });

    session.client.setPersona(SteamUser.EPersonaState.Invisible);
    container.logger.info(chalk`{bold.yellow ${session.username} logged on!}`);

    await this.updateGameList(session);

    const sideTask = await Task.createTask({
      start: () => sideTask.update(),
      update: async () => {
        if (session.isExpired) {
          return sideTask.unload();
        }

        if (Object.values(session.family).some((value) => value !== 0)) {
          session.getState().setEnabled(false);
        } else if (!session.isPlaying) {
          const steamUser = await getSteamUser(session, session.client.steamID!);
          session.getState().setEnabled(steamUser.onlineState === 'offline');
        }

        if (clientConfig.fetchFreeGames || session.fetchFreeGames) {
          await this.collectFreeGames(session);
        }
      },
      options: { name: KEY_TASK_IDLER(session.sessionID, 'SIDE'), delay: 60_000 },
    });

    await waitUntil(() => session.isExpired || session.isEnabled || session.ownedGameList.length > 0);
    if (session.isExpired) return;

    container.logger.info(`${session.username} owns ${session.ownedGameList.length} game(s).`);

    let nextIdleTime = 0;
    let nextGameRefreshTime = 0;
    const mainTask = await Task.createTask({
      start: async () => {
        await waitUntil(() => session.isExpired || session.isEnabled);

        nextGameRefreshTime = Date.now() + clientConfig.refreshGames;
        await mainTask.update();
      },
      update: async () => {
        if (session.isExpired) {
          return mainTask.unload();
        }

        if (!session.isEnabled) {
          nextIdleTime = 0;
          session.gamesPlayed([]);
          return;
        }

        if (nextGameRefreshTime < Date.now()) {
          await this.updateGameList(session);
          nextGameRefreshTime = Date.now() + clientConfig.refreshGames;
        }
        if (nextIdleTime < Date.now()) {
          nextIdleTime = this.startIdleGames(session);
        }
      },
      options: { name: KEY_TASK_IDLER(session.sessionID, 'MAIN'), delay: 60_000 },
    });
  }

  private async updateGameList(session: Session): Promise<void> {
    const clientConfig = this.container.client.config;
    const includeIds = new Set([...clientConfig.whitelistGameIds, ...session.whitelistGameIds]);
    const excludeIds = new Set([
      ...clientConfig.blacklistGameIds,
      ...session.blacklistGameIds,
      ...session.bannedGameIds,
      ...session.ownedGameList.map((game) => game.appid),
    ]);

    let timeoutId: NodeJS.Timeout;
    return waitUntil(async (release) => {
      if (session.isExpired) {
        return release();
      }

      const result = await Result.fromAsync(async () => {
        const userAppsData = await new Promise<{ apps: GameContext[] }>((resolve, reject) => {
          timeoutId = setTimeout(() => reject(TIMEOUT_MESSAGE), 60_000);
          session.client
            .getUserOwnedApps(session.steamID, {
              includeAppInfo: true,
              includeFreeSub: true,
              skipUnvettedApps: false,
              includePlayedFreeGames: true,
            } as SteamUser.GetUserOwnedAppsOptions)
            .then(resolve)
            .catch(reject);
        });

        clearTimeout(timeoutId);
        const combinedGames = unionBy(
          userAppsData.apps,
          [...includeIds].map((appid) => ({ appid, name: 'unknown' })),
          (game) => game.appid,
        );

        await waitForEach(combinedGames, (game) => {
          if (excludeIds.has(game.appid) || EXCLUDED_GAME_NAME.test(game.name)) {
            return;
          }
          session.ownedGameList.push({ appid: game.appid, name: game.name });
        });
        release();
      });

      if (result.isErr()) {
        clearTimeout(timeoutId);
        const error = result.unwrapErr();
        if (isErrorLike(error) && error.message !== TIMEOUT_MESSAGE) {
          container.logger.error(error, `${session.username} ${this.updateGameList.name}.`);
        }
        await sleep(10_000);
      }
    });
  }

  private async collectFreeGames(session: Session): Promise<void> {
    const clientConfig = this.container.client.config;
    const claimExcludeIds = new Set([
      ...clientConfig.blacklistGameIds,
      ...session.blacklistGameIds,
      ...session.bannedGameIds,
      ...session.ownedGameList.map((game) => game.appid),
    ]);

    return waitUntil(async (release, retries) => {
      if (session.isExpired || retries >= 3) {
        return release();
      }

      const searchResult = await requestDefault({
        url: 'https://store.steampowered.com/search/results',
        searchParams: {
          sort_by: 'Released_DESC',
          force_infinite: 1,
          maxprice: 'free',
          category1: '998,10',
          os: 'win',
          page: session.lastPage,
        },
        retry: -1,
      });

      if (searchResult.isOk()) {
        const { body } = searchResult.unwrap();
        const gameIdMatches = body.match(/(?<=data-ds-appid=")[^"]*/g);
        if (gameIdMatches && gameIdMatches.length > 0) {
          const appIds = gameIdMatches.map((id) => parseInt(id, 10)).filter((id) => !isNaN(id));

          await waitForEach(appIds, async (appid) => {
            if (claimExcludeIds.has(appid) || session.freeGameIds.includes(appid)) return;

            const detailResult = await requestDefault({
              url: `https://store.steampowered.com/api/appdetails?appids=${appid}`,
              retry: -1,
            });

            const app = await detailResult.match({
              ok: ({ body }) => sleep(1_500, JSON.parse(body)[appid] as AppDetails),
              err: () => null,
            });

            if (!app?.data) {
              claimExcludeIds.add(appid);
              return;
            }
            if (!app.success || !app.data.is_free || app.data.release_date.coming_soon) {
              return;
            }

            session.freeGameIds.push(appid);
            session.freeGameList.push({ name: app.data.name, appid: app.data.steam_appid });
          });
          session.lastPage++;
        } else {
          if (session.lastLoop >= 5) {
            session.lastPage = 1;
            session.forceRegister = true;
            session.freeGameIds.length = 0;
          }
          if (session.freeGameLength === session.freeGameList.length) {
            session.lastLoop++;
          }
          session.freeGameLength = session.freeGameList.length;
        }

        await session.store.writeFile({
          lastPage: session.lastPage,
          freeGameList: session.freeGameList,
          freeGameIds: session.freeGameIds,
        });
        release();
      } else {
        const error = searchResult.unwrapErr();
        if (isErrorLike(error) && error.message !== TIMEOUT_MESSAGE) {
          container.logger.error(error, `${session.username} ${this.collectFreeGames.name}.`);
        }
        await sleep(10_000);
      }

      queueMicrotask(() => this.registerFreeGames(session));
    });
  }

  private readonly registerMutex = new Mutex();
  private async registerFreeGames(session: Session): Promise<void> {
    if (this.registerMutex.lock()) {
      return;
    }

    const clientConfig = this.container.client.config;
    return waitUntil(async (release, retries) => {
      const isRetryLimitReached = retries >= 3 && session.freeGameList.length < 50;
      const isSufficientGamesOrForced = session.freeGameList.length >= 50 || session.forceRegister;
      if (session.isExpired || isRetryLimitReached || !isSufficientGamesOrForced) {
        this.registerMutex.release();
        return release();
      }

      const gamesToRegister = session.freeGameList.slice(0, 50);
      const gameIdsToRegister = new Set(gamesToRegister.map((game) => game.appid));

      const result = await Result.fromAsync(async () => {
        await session.client.requestFreeLicense([...gameIdsToRegister]);
        const message = `${gamesToRegister.length}/${session.freeGameList.length}/${session.lastPage} new games.`;
        container.logger.info(`${session.username} added ${message}`);

        remove(session.freeGameList, (game) => gameIdsToRegister.has(game.appid));
      });

      if (result.isErr()) {
        const error = result.unwrapErr();
        if (isErrorLike<{ eresult: number }>(error) && error.message !== TIMEOUT_MESSAGE) {
          container.logger.error(error, `${session.username} ${this.registerFreeGames.name}.`);
          if (error.message === 'RateLimitExceeded') {
            queueMicrotask(async () => {
              let lockId: NodeJS.Timeout | null;
              lockId = setTimeout(() => (lockId = null), clientConfig.refreshGames);
              await waitUntil(() => !lockId || session.isExpired, { delay: 1000 });

              clearTimeout(lockId);
              this.registerMutex.release();
            });
            return release();
          }
        }
        return sleep(10_000, false);
      }

      session.lastLoop = 0;
      session.forceRegister = false;
      await session.store.writeFile({
        lastPage: session.lastPage,
        freeGameList: session.freeGameList,
        freeGameIds: session.freeGameIds,
      });

      this.registerMutex.release();
      release();
    });
  }

  private startIdleGames(session: Session): number {
    const maxIdleCount = Math.min(32, session.ownedGameList.length);

    const idleMs = random(60, 120) * 60_000;
    const nextIdleAt = Date.now() + idleMs;

    const allOwnedIds = session.ownedGameList.map((game) => game.appid);
    const idsToIdle = shuffle(allOwnedIds).slice(0, maxIdleCount);

    session.gamesPlayed(idsToIdle);

    const durationString = humanizeDuration(idleMs, { units: ['h', 'm'], round: true });
    container.logger.info(`${session.username} idling ${idsToIdle.length} games for ${durationString}.`);
    container.logger.info(`• ${idsToIdle.join(', ')}.`);
    return nextIdleAt;
  }
}
