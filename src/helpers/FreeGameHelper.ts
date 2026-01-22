import { isObjectLike } from '@vegapunk/utilities/common';
import { Array, Effect, HashSet, Option } from 'effect';
import SteamUser from 'steam-user';

import { catchAndLogUnlessTimeout, FreeGameError, RetryTimeoutPolicy } from '../core/errors';
import { ConfigStoreTag, RegistrationSemaphore, SessionStore, UserContext } from '../core/schemas';
import { filterGames, getRateLimitSleep, getUserPreferences, parseAppIdsFromHtml } from '../core/utils';
import { SteamClientTag } from '../services/SteamService';
import { HttpClientTag, request } from '../structures/HttpClient';

const MAX_FREE_GAMES_BATCH = 50;

const fetchSearchPage = (page: number): Effect.Effect<string, FreeGameError, HttpClientTag> =>
  request<string>({
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
    (effect) => Effect.retry(effect, RetryTimeoutPolicy),
    Effect.map((res) => res.body),
  );

export const registerFreeGames = (user: UserContext): Effect.Effect<void, never, SteamClientTag | ConfigStoreTag | SessionStore> =>
  Effect.gen(function* () {
    const steamClient = yield* SteamClientTag;
    const configStore = yield* ConfigStoreTag;
    const sessionStore = yield* SessionStore;

    const configData = yield* configStore.get;
    const sessionData = yield* sessionStore.get;

    const isSufficient = sessionData.freeGameList.length >= MAX_FREE_GAMES_BATCH || sessionData.forceRegister;
    if (!isSufficient || sessionData.freeGameList.length === 0) {
      return;
    }

    const gamesToRegister = Array.take(sessionData.freeGameList, MAX_FREE_GAMES_BATCH);
    const gameIdsToRegister = HashSet.fromIterable(Array.map(gamesToRegister, (g) => g.appId));

    yield* steamClient.requestFreeLicense([...gameIdsToRegister] as readonly number[]).pipe(
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
      freeGameList: Array.filter(data.freeGameList, (g) => !HashSet.has(gameIdsToRegister, g.appId)),
      lastLoop: 0,
      forceRegister: false,
    }));
  });

export const collectFreeGames = (
  user: UserContext,
): Effect.Effect<void, never, ConfigStoreTag | SessionStore | SteamClientTag | HttpClientTag | RegistrationSemaphore> =>
  Effect.gen(function* () {
    const configStore = yield* ConfigStoreTag;
    const sessionStore = yield* SessionStore;
    const configData = yield* configStore.get;

    if (!configData.fetchFreeGames && !user.fetchFreeGames) {
      return;
    }

    const steamClient = yield* SteamClientTag;
    const sessionData = yield* sessionStore.get;

    const { whitelist, blacklist } = getUserPreferences(configData, user, [
      ...sessionData.bannedGameIds,
      ...Array.map(sessionData.ownedGameList, (g) => g.appId),
    ]);

    const appIds = yield* fetchSearchPage(sessionData.lastPage).pipe(
      Effect.map(parseAppIdsFromHtml),
      catchAndLogUnlessTimeout(`${user.username} FreeGame collection failed`, [] as readonly number[]),
    );

    if (appIds.length > 0) {
      const appIdsToCheck = Array.filter(appIds, (id) => !HashSet.has(blacklist, id) && !Array.contains(sessionData.freeGameIds, id));

      if (appIdsToCheck.length > 0) {
        const productInfo = yield* steamClient.getProductInfo(appIdsToCheck, []).pipe(Effect.catchAll(() => Effect.succeed({ apps: null })));

        const apps = productInfo.apps;
        if (isObjectLike(apps)) {
          const gamesToFilter = Array.filterMap(appIdsToCheck, (appId) => {
            const app = apps[appId];
            const common = app?.appinfo?.common as Record<string, unknown> | undefined;
            if (!!common && common.releasestate === 'released' && String(common.type).toLowerCase() === 'game' && typeof common.name === 'string') {
              return Option.some({ name: String(common.name), appId });
            }
            return Option.none();
          });

          const filteredGames = filterGames(gamesToFilter, { whitelist, blacklist });

          if (filteredGames.length > 0) {
            yield* sessionStore.update((data) => ({
              ...data,
              freeGameIds: [...data.freeGameIds, ...Array.map(filteredGames, (g) => g.appId)],
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
