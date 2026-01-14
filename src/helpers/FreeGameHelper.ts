import { isObjectLike } from '@vegapunk/utilities/common';
import { Effect } from 'effect';
import SteamUser from 'steam-user';

import { catchAndLogUnlessTimeout, FreeGameError, RetryTimeoutPolicy } from '../core/errors';
import { ConfigStoreTag, RegistrationSemaphore, SessionStore, UserContext } from '../core/schemas';
import { filterGames, getRateLimitSleep, parseAppIdsFromHtml, userPreferences } from '../core/utils';
import { SteamClientTag } from '../services/SteamService';
import { request } from '../structures/HttpClient';

const MAX_FREE_GAMES_BATCH = 50;

const fetchSearchPage = (page: number) =>
  request({
    url: 'https://store.steampowered.com/search/results',
    searchParams: {
      sort_by: 'Released_DESC',
      force_infinite: 1,
      maxprice: 'free',
      category1: '998,10',
      os: 'win',
      page,
    },
    retry: -1,
  }).pipe(
    Effect.mapError((cause) => new FreeGameError({ message: 'Failed to fetch HTML', cause })),
    RetryTimeoutPolicy,
  );

export const collectFreeGames = (user: UserContext) =>
  Effect.gen(function* () {
    const configStore = yield* ConfigStoreTag;
    const sessionStore = yield* SessionStore;
    const configData = yield* configStore.get;

    if (!configData.fetchFreeGames && !user.fetchFreeGames) return;

    const steamClient = yield* SteamClientTag;
    const sessionData = yield* sessionStore.get;

    const { whitelist, blacklist } = userPreferences(configData, user, [
      ...sessionData.bannedGameIds,
      ...sessionData.ownedGameList.map((g) => g.appId),
    ]);

    const appIds = yield* fetchSearchPage(sessionData.lastPage).pipe(
      Effect.map((res) => parseAppIdsFromHtml(res.body)),
      catchAndLogUnlessTimeout(`${user.username} FreeGame collection failed`, []),
    );

    if (appIds.length > 0) {
      const appIdsToCheck = appIds.filter((id) => !blacklist.has(id) && !sessionData.freeGameIds.includes(id));

      if (appIdsToCheck.length > 0) {
        const productInfo = yield* steamClient.getProductInfo(appIdsToCheck, []).pipe(Effect.catchAll(() => Effect.succeed({ apps: null })));

        const apps = productInfo.apps;
        if (isObjectLike(apps)) {
          const gamesToFilter = appIdsToCheck
            .map((appId) => ({ appId, common: apps[appId]?.appinfo?.common }))
            .filter((item) => {
              const common = item.common;
              return !!common && common.releasestate === 'released' && common.type?.toLowerCase() === 'game' && typeof common.name === 'string';
            })
            .map(({ appId, common }) => ({ name: (common as any).name as string, appId }));

          const filteredGames = filterGames(gamesToFilter, { whitelist, blacklist });

          if (filteredGames.length > 0) {
            yield* sessionStore.update((data) => ({
              ...data,
              freeGameIds: [...data.freeGameIds, ...filteredGames.map((g) => g.appId)],
              freeGameList: [...data.freeGameList, ...filteredGames],
            }));
          }
        }
      }
      yield* sessionStore.update((data) => ({ ...data, lastPage: data.lastPage + 1 }));
    } else {
      yield* sessionStore.update((data) => {
        const shouldReset = data.lastLoop + 1 >= 5;
        return {
          ...data,
          lastLoop: shouldReset ? 0 : data.lastLoop + 1,
          lastPage: shouldReset ? 1 : data.lastPage,
          forceRegister: shouldReset ? true : data.forceRegister,
          freeGameIds: shouldReset ? [] : data.freeGameIds,
        };
      });
    }

    const semaphore = yield* RegistrationSemaphore;
    yield* semaphore.withPermits(1)(registerFreeGames(user));
  });

export const registerFreeGames = (user: UserContext) =>
  Effect.gen(function* () {
    const steamClient = yield* SteamClientTag;
    const configStore = yield* ConfigStoreTag;
    const sessionStore = yield* SessionStore;

    const configData = yield* configStore.get;
    const sessionData = yield* sessionStore.get;

    const isSufficient = sessionData.freeGameList.length >= MAX_FREE_GAMES_BATCH || sessionData.forceRegister;
    if (!isSufficient || sessionData.freeGameList.length === 0) return;

    const gamesToRegister = sessionData.freeGameList.slice(0, MAX_FREE_GAMES_BATCH);
    const gameIdsToRegister = new Set(gamesToRegister.map((g) => g.appId));

    yield* steamClient.requestFreeLicense([...gameIdsToRegister]).pipe(
      Effect.tapError((error) =>
        Effect.gen(function* () {
          if ('eresult' in error && error.eresult === SteamUser.EResult.RateLimitExceeded) {
            const sleepMs = getRateLimitSleep(configData.refreshGames);
            yield* Effect.logWarning(`${user.username} FreeGame rate limit exceeded. Waiting ${sleepMs / 60000}m...`);
            yield* Effect.sleep(`${sleepMs} millis`);
          }
        }),
      ),
      RetryTimeoutPolicy,
      catchAndLogUnlessTimeout(`${user.username} FreeGame registration failed`, undefined),
    );

    yield* Effect.logInfo(`${user.username} added ${gamesToRegister.length}/${sessionData.freeGameList.length}/${sessionData.lastPage} new games`);

    yield* sessionStore.update((data) => ({
      ...data,
      freeGameList: data.freeGameList.filter((g) => !gameIdsToRegister.has(g.appId)),
      lastLoop: 0,
      forceRegister: false,
    }));
  });
