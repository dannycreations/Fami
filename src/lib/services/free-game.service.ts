import { container } from '@vegapunk/core';
import { requestDefault } from '@vegapunk/request';
import { Mutex } from '@vegapunk/struct';
import { isObjectLike, remove } from '@vegapunk/utilities/common';
import { isErrorLike, Result } from '@vegapunk/utilities/result';
import { sleep, waitForEach, waitUntil } from '@vegapunk/utilities/sleep';

import type { Session } from '../struct/Session';

const TIMEOUT_MESSAGE = 'Request timed out' as const;
const registerMutex = new Mutex();

export async function collectFreeGames(session: Session): Promise<void> {
  const claimExcludeIds = session.getExcludedAppIds();

  await waitUntil(async (release, retries) => {
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
      const gameIdMatches = body.match(/data-ds-appid="([^"]+)"/g);
      if (gameIdMatches && gameIdMatches.length > 0) {
        const allAppIds = [...new Set(gameIdMatches.flatMap((m) => m.match(/\d+/g) || []).map(Number))];
        const appIdsToCheck = allAppIds.filter((id) => !claimExcludeIds.has(id) && !session.freeGameIds.includes(id));

        if (appIdsToCheck.length > 0) {
          const productInfoResult = await Result.fromAsync(() => session.client.getProductInfo(appIdsToCheck, []));
          const apps = productInfoResult.unwrapOr({ apps: null }).apps;
          if (isObjectLike(apps)) {
            await waitForEach(appIdsToCheck, (appid) => {
              const app = apps[appid];
              const common = app?.appinfo?.common;

              if (!common) {
                claimExcludeIds.add(appid);
                return;
              }

              if (common.releasestate !== 'released' || common.type?.toLowerCase() !== 'game') {
                return;
              }

              session.freeGameIds.push(appid);
              session.freeGameList.push({ name: common.name, appid });
            });
          }
        }
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
        container.logger.error(error, `FreeGame: ${session.username} error during collection`);
      }

      await sleep(10_000);
    }

    queueMicrotask(() => registerFreeGames(session));
  });
}

export async function registerFreeGames(session: Session): Promise<void> {
  if (registerMutex.lock()) {
    return;
  }

  try {
    const clientConfig = container.client.config;
    await waitUntil(async (release, retries) => {
      const isRetryLimitReached = retries >= 3 && session.freeGameList.length < 50;
      const isSufficientGamesOrForced = session.freeGameList.length >= 50 || session.forceRegister;

      if (session.isExpired || isRetryLimitReached || !isSufficientGamesOrForced) {
        return release();
      }

      const gamesToRegister = session.freeGameList.slice(0, 50);
      const gameIdsToRegister = new Set(gamesToRegister.map((game) => game.appid));

      const result = await Result.fromAsync(async () => {
        await session.client.requestFreeLicense([...gameIdsToRegister]);
        const message = `${gamesToRegister.length}/${session.freeGameList.length}/${session.lastPage} new games`;
        container.logger.info(`${session.username} added ${message}`);

        remove(session.freeGameList, (game) => gameIdsToRegister.has(game.appid));
      });

      if (result.isErr()) {
        const error = result.unwrapErr();
        if (isErrorLike<{ eresult: number }>(error) && error.message !== TIMEOUT_MESSAGE) {
          container.logger.error(error, `FreeGame: ${session.username} error during registration`);
          if (error.message === 'RateLimitExceeded') {
            queueMicrotask(async () => {
              try {
                let lockId: NodeJS.Timeout | null = setTimeout(() => (lockId = null), clientConfig.refreshGames);
                await waitUntil(() => !lockId || session.isExpired, { delay: 1000 });
                if (lockId) clearTimeout(lockId);
              } finally {
                registerMutex.release();
              }
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

      release();
    });
  } finally {
    registerMutex.release();
  }
}
