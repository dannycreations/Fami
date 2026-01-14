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
    Effect.mapError((error) => new FreeGameError({ message: 'Failed to fetch HTML', cause: error })),
    RetryTimeoutPolicy,
  );

export const collectFreeGames = (user: UserContext) =>
  Effect.gen(function* (_) {
    const configStore = yield* _(ConfigStoreTag);
    const sessionStore = yield* _(SessionStore);
    const configData = yield* _(configStore.get);

    if (!configData.fetchFreeGames && !user.fetchFreeGames) return;

    const steamClient = yield* _(SteamClientTag);
    const sessionData = yield* _(sessionStore.get);

    const { whitelist, blacklist } = userPreferences(configData, user, [
      ...sessionData.bannedGameIds,
      ...sessionData.ownedGameList.map((g) => g.appId),
    ]);

    const appIds = yield* _(
      fetchSearchPage(sessionData.lastPage),
      Effect.map((res) => parseAppIdsFromHtml(res.body)),
      catchAndLogUnlessTimeout(`${user.username} FreeGame collection failed`, []),
    );

    if (appIds.length > 0) {
      const appIdsToCheck = appIds.filter((id) => !blacklist.has(id) && !sessionData.freeGameIds.includes(id));

      if (appIdsToCheck.length > 0) {
        const productInfo = yield* _(
          steamClient.getProductInfo(appIdsToCheck, []),
          Effect.catchAll(() => Effect.succeed({ apps: null })),
        );

        if (isObjectLike(productInfo.apps)) {
          const gamesToFilter = appIdsToCheck
            .map((appId) => ({ appId, common: productInfo.apps![appId]?.appinfo?.common }))
            .filter(({ common }) => common && common.releasestate === 'released' && common.type?.toLowerCase() === 'game')
            .map(({ appId, common }) => ({ name: common!.name, appId }));

          const filteredGames = filterGames(gamesToFilter, { whitelist, blacklist });

          if (filteredGames.length > 0) {
            yield* _(
              sessionStore.update((data) => ({
                ...data,
                freeGameIds: [...data.freeGameIds, ...filteredGames.map((g) => g.appId)],
                freeGameList: [...data.freeGameList, ...filteredGames],
              })),
            );
          }
        }
      }
      yield* _(sessionStore.update((data) => ({ ...data, lastPage: data.lastPage + 1 })));
    } else {
      yield* _(
        sessionStore.update((data) => {
          const shouldReset = data.lastLoop + 1 >= 5;
          return {
            ...data,
            lastLoop: shouldReset ? 0 : data.lastLoop + 1,
            lastPage: shouldReset ? 1 : data.lastPage,
            forceRegister: shouldReset ? true : data.forceRegister,
            freeGameIds: shouldReset ? [] : data.freeGameIds,
          };
        }),
      );
    }

    const semaphore = yield* _(RegistrationSemaphore);
    yield* _(semaphore.withPermits(1)(registerFreeGames(user)));
  });

export const registerFreeGames = (user: UserContext) =>
  Effect.gen(function* (_) {
    const steamClient = yield* _(SteamClientTag);
    const configStore = yield* _(ConfigStoreTag);
    const sessionStore = yield* _(SessionStore);

    const configData = yield* _(configStore.get);
    const sessionData = yield* _(sessionStore.get);

    const isSufficient = sessionData.freeGameList.length >= MAX_FREE_GAMES_BATCH || sessionData.forceRegister;
    if (!isSufficient || sessionData.freeGameList.length === 0) return;

    const gamesToRegister = sessionData.freeGameList.slice(0, MAX_FREE_GAMES_BATCH);
    const gameIdsToRegister = new Set(gamesToRegister.map((g) => g.appId));

    yield* _(
      steamClient.requestFreeLicense([...gameIdsToRegister]),
      Effect.tapError((error) =>
        Effect.gen(function* (_) {
          if ('eresult' in error && error.eresult === SteamUser.EResult.RateLimitExceeded) {
            const sleepMs = getRateLimitSleep(configData.refreshGames);
            yield* _(Effect.logWarning(`${user.username} FreeGame rate limit exceeded. Waiting ${sleepMs / 60000}m...`));
            yield* _(Effect.sleep(`${sleepMs} millis`));
          }
        }),
      ),
      RetryTimeoutPolicy,
      catchAndLogUnlessTimeout(`${user.username} FreeGame registration failed`, undefined),
    );

    yield* _(Effect.logInfo(`${user.username} added ${gamesToRegister.length}/${sessionData.freeGameList.length}/${sessionData.lastPage} new games`));

    yield* _(
      sessionStore.update((data) => ({
        ...data,
        freeGameList: data.freeGameList.filter((g) => !gameIdsToRegister.has(g.appId)),
        lastLoop: 0,
        forceRegister: false,
      })),
    );
  });
