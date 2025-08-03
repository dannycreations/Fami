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

const KEY_IDLER_PFX = (key: string, type: 'MAIN' | 'SIDE'): string => `${key}_${type}_IDLER`;
const TIMEOUT_MESSAGE = 'Request timed out' as const;
const EXCLUDED_GAME_NAME_PATTERNS: RegExp[] = [
  /(\sPTS|PTS\s)/i,
  /(\sBeta|Beta\s)/i,
  /(\sDemo|Demo\s)/i,
  /(\sTest|Test\s)/i,
  /(\sUnstable|Unstable\s)/i,
] as const;

export class UserListener extends Listener<'loggedOn'> {
  public constructor(context: Listener.LoaderContext) {
    super(context, {
      emitter: container.steam,
      event: 'loggedOn',
    });
  }

  public async run(session: Session): Promise<void> {
    const clientCfg = this.container.client.config;
    const userCfg = clientCfg.users.find((u) => u.username === session.username)!;
    userCfg.id = session.client.steamID!.toString();

    session.client.setPersona(SteamUser.EPersonaState.Invisible);
    container.logger.info(chalk`{bold.yellow ${session.username} logged on!}`);

    await this.updateUserGameList(session);

    const sideTask = await Task.createTask({
      start: async function () {
        await this.update();
      },
      update: async () => {
        if (session.isExpired) {
          return sideTask.unload();
        }

        if (Object.values(session.family).some((r) => r !== 0)) {
          session.enabled = false;
        } else if (!session.playing) {
          const steamUsr = await getSteamUser(session, session.client.steamID!);
          session.enabled = steamUsr.onlineState === 'offline';
        }

        if (clientCfg.fetchFreeGames || session.fetchFreeGames) {
          await this.processFreeGames(session);
        }
      },
      options: { name: KEY_IDLER_PFX(session.sessionID, 'SIDE'), delay: 60_000 },
    });

    await waitUntil(() => session.isExpired || session.enabled || session.ownedGameList.length > 0);
    if (session.isExpired) return;

    container.logger.info(`${session.username} owns ${session.ownedGameList.length} game(s).`);

    let nextIdleTime = 0;
    let nextGameRefreshTime = 0;
    const mainTask = await Task.createTask({
      start: async function () {
        await waitUntil(() => session.isExpired || session.enabled);

        nextGameRefreshTime = Date.now() + clientCfg.refreshGames;
        await this.update();
      },
      update: async () => {
        if (session.isExpired) {
          return mainTask.unload();
        }

        if (!session.enabled) {
          nextIdleTime = 0;
          if (session.playing) {
            session.playing = false;
            session.client.gamesPlayed([]);
            session.client.setPersona(SteamUser.EPersonaState.Invisible);
          }
          return;
        }

        if (nextGameRefreshTime < Date.now()) {
          await this.updateUserGameList(session);
          nextGameRefreshTime = Date.now() + clientCfg.refreshGames;
        }
        if (nextIdleTime < Date.now()) {
          nextIdleTime = this.selectAndIdleGames(session);
        }
      },
      options: { name: KEY_IDLER_PFX(session.sessionID, 'MAIN'), delay: 60_000 },
    });
  }

  private async updateUserGameList(session: Session): Promise<void> {
    const clientCfg = this.container.client.config;
    const includeIds = new Set([...clientCfg.whitelistGameIds, ...session.whitelistGameIds]);
    const excludeIds = new Set([
      ...clientCfg.blacklistGameIds,
      ...session.blacklistGameIds,
      ...session.bannedGameIds,
      ...session.ownedGameList.map((r) => r.appid),
    ]);

    let timeoutId: NodeJS.Timeout;
    return waitUntil(async (resolve) => {
      if (session.isExpired) {
        return resolve();
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
            } as {})
            .then(resolve)
            .catch(reject);
        });

        clearTimeout(timeoutId);
        const combinedGames = unionBy(
          userAppsData.apps,
          [...includeIds].map((appid) => ({ appid, name: 'unknown' })),
          (r) => r.appid,
        );

        await waitForEach(combinedGames, (game) => {
          if (excludeIds.has(game.appid) || EXCLUDED_GAME_NAME_PATTERNS.some((r) => r.test(game.name))) {
            return;
          }
          session.ownedGameList.push({ appid: game.appid, name: game.name });
        });
        resolve();
      });

      if (result.isErr()) {
        clearTimeout(timeoutId);
        const error = result.unwrapErr();
        if (isErrorLike(error) && error.message !== TIMEOUT_MESSAGE) {
          container.logger.error(error, `${session.username} updateUserGameList, with reason: ${error.message}.`);
        }
        await sleep(10_000);
      }
    });
  }

  private async processFreeGames(session: Session): Promise<void> {
    const clientCfg = this.container.client.config;
    const claimExcludeIds = new Set([
      ...clientCfg.blacklistGameIds,
      ...session.blacklistGameIds,
      ...session.bannedGameIds,
      ...session.ownedGameList.map((r) => r.appid),
    ]);
    return waitUntil(async (resolve, retries) => {
      if (session.isExpired || retries >= 3) {
        return resolve();
      }

      const searchRes = await requestDefault({
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

      if (searchRes.isOk()) {
        const { body } = searchRes.unwrap();
        const gameIdMatches = body.match(/(?<=data-ds-appid=")[^"]*/g);
        if (gameIdMatches && gameIdMatches.length > 0) {
          const appIds = gameIdMatches.map((id) => parseInt(id, 10)).filter((id) => !isNaN(id));

          await waitForEach(appIds, async (appid) => {
            if (claimExcludeIds.has(appid) || session.freeGameIds.includes(appid)) return;

            const detailRes = await requestDefault({
              url: `https://store.steampowered.com/api/appdetails?appids=${appid}`,
              retry: -1,
            });

            const app = await detailRes.match({
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
            session.forceRequest = true;
            session.freeGameIds.length = 0;
          }
          if (session.freeGameLength === session.freeGameList.length) {
            session.lastLoop++;
          }
          session.freeGameLength = session.freeGameList.length;
        }

        const _session = Session.stores.get(session.username)!;
        await _session.stores.writeFile({
          lastPage: session.lastPage,
          freeGameList: session.freeGameList,
          freeGameIds: session.freeGameIds,
        });
        resolve();
      } else {
        const error = searchRes.unwrapErr();
        if (isErrorLike(error) && error.message !== TIMEOUT_MESSAGE) {
          container.logger.error(error, `${session.username} processFreeGames, with reason: ${error.message}.`);
        }
        await sleep(10_000);
      }

      queueMicrotask(() => this.requestFreeGamesLicense(session));
    });
  }

  private readonly requestMutex = new Mutex();
  private async requestFreeGamesLicense(session: Session): Promise<void> {
    if (this.requestMutex.lock()) {
      return;
    }

    const clientCfg = this.container.client.config;
    return waitUntil(async (resolve, retries) => {
      const isExpired = session.isExpired;
      const isRetryLimitReached = retries >= 3 && session.freeGameList.length < 50;
      const isSufficientGamesOrForced = session.freeGameList.length >= 50 || session.forceRequest;
      if (isExpired || isRetryLimitReached || !isSufficientGamesOrForced) {
        this.requestMutex.release();
        return resolve();
      }

      const gamesToReq = session.freeGameList.slice(0, 50);
      const gameIdsToReq = new Set(gamesToReq.map((g) => g.appid));

      const result = await Result.fromAsync(async () => {
        await session.client.requestFreeLicense([...gameIdsToReq]);
        const msg = `${gamesToReq.length}/${session.freeGameList.length}/${session.lastPage} new games.`;
        container.logger.info(`${session.username} added ${msg}`);

        remove(session.freeGameList, (r) => gameIdsToReq.has(r.appid));
      });

      if (result.isErr()) {
        const error = result.unwrapErr();
        if (isErrorLike<{ eresult: number }>(error) && error.message !== TIMEOUT_MESSAGE) {
          container.logger.error(error, `${session.username} requestFreeGamesLicense, with reason: ${error.message}.`);
          if (error.message === 'RateLimitExceeded') {
            queueMicrotask(async () => {
              let lockId: NodeJS.Timeout | null;
              lockId = setTimeout(() => (lockId = null), clientCfg.refreshGames);
              await waitUntil(() => !lockId || session.isExpired, { delay: 1000 });

              clearTimeout(lockId);
              this.requestMutex.release();
            });
            return resolve();
          }
        }
        return sleep(10_000, false);
      }

      session.lastLoop = 0;
      session.forceRequest = false;
      const _session = Session.stores.get(session.username)!;
      await _session.stores.writeFile({
        lastPage: session.lastPage,
        freeGameList: session.freeGameList,
        freeGameIds: session.freeGameIds,
      });

      this.requestMutex.release();
      resolve();
    });
  }

  private selectAndIdleGames(session: Session): number {
    const maxIdleCount = Math.min(32, session.ownedGameList.length);

    const idleMs = random(60, 120) * 60_000;
    const nextIdleAt = Date.now() + idleMs;

    const allOwnedIds = session.ownedGameList.map((r) => r.appid);
    const idsToIdle = shuffle(allOwnedIds).slice(0, maxIdleCount);

    session.client.setPersona(SteamUser.EPersonaState.Online);
    session.client.gamesPlayed(idsToIdle);
    session.playing = true;

    const durationStr = humanizeDuration(idleMs, { units: ['h', 'm'], round: true });
    container.logger.info(`${session.username} idling ${idsToIdle.length} games for ${durationStr}.`);
    container.logger.info(`• ${idsToIdle.join(', ')}.`);
    return nextIdleAt;
  }
}
