import { isObjectLike } from '@vegapunk/utilities/common';
import { Effect, HashSet } from 'effect';
import SteamUser from 'steam-user';

import { catchAndLogUnlessTimeout, FreeGameError, RetryTimeoutPolicy } from '../core/errors';
import { ConfigStoreTag, GameContext, RegistrationSemaphore, SessionStore, UserContext } from '../core/schemas';
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
    Effect.retry(RetryTimeoutPolicy),
    Effect.map((res) => res.body),
  );

export const registerFreeGames = (user: UserContext): Effect.Effect<void, never, SteamClientTag | ConfigStoreTag | SessionStore> =>
  Effect.gen(function* () {
    const sessionStore = yield* SessionStore;
    const sessionData = yield* sessionStore.get;

    const isSufficient = sessionData.freeGameList.length >= MAX_FREE_GAMES_BATCH || sessionData.forceRegister;
    if (!isSufficient || sessionData.freeGameList.length === 0) {
      return;
    }

    const steamClient = yield* SteamClientTag;
    const configStore = yield* ConfigStoreTag;
    const configData = yield* configStore.get;

    const gamesToRegister = sessionData.freeGameList.slice(0, MAX_FREE_GAMES_BATCH);
    const gameIdsToRegister = gamesToRegister.map((g) => g.appId);

    yield* steamClient.requestFreeLicense(gameIdsToRegister).pipe(
      Effect.tapError((error) =>
        Effect.gen(function* () {
          if ('eresult' in error && error.eresult === SteamUser.EResult.RateLimitExceeded) {
            const sleepMs = getRateLimitSleep(configData.refreshGames);
            yield* Effect.logWarning(`${user.username} FreeGame rate limit exceeded. Waiting ${sleepMs / 60000}m...`);
            yield* Effect.sleep(`${sleepMs} millis`);
          }
        }),
      ),
      catchAndLogUnlessTimeout(`${user.username} FreeGame registration failed`, undefined),
    );

    yield* Effect.logInfo(`${user.username} added ${gamesToRegister.length}/${sessionData.freeGameList.length}/${sessionData.lastPage} new games`);

    const gameIdsSet = new Set(gameIdsToRegister);
    yield* sessionStore.update((data) => ({
      ...data,
      freeGameList: data.freeGameList.filter((g) => !gameIdsSet.has(g.appId)),
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

    const bannedAndOwned = HashSet.union(sessionData.bannedGameIds, sessionData.ownedGameIds);
    const { whitelist, blacklist } = getUserPreferences(configData, user, bannedAndOwned);

    const html = yield* fetchSearchPage(sessionData.lastPage).pipe(catchAndLogUnlessTimeout(`${user.username} FreeGame collection failed`, ''));

    if (html.length > 0) {
      const appIds = parseAppIdsFromHtml(html);
      const appIdsToCheck = appIds.filter((id) => !HashSet.has(blacklist, id) && !HashSet.has(sessionData.freeGameIds, id));

      if (appIdsToCheck.length > 0) {
        const productInfo = yield* steamClient.getProductInfo(appIdsToCheck, []).pipe(Effect.catchAll(() => Effect.succeed({ apps: null })));

        const apps = productInfo.apps;
        if (isObjectLike(apps)) {
          const gamesToFilter: GameContext[] = [];
          for (const appId of appIdsToCheck) {
            const app = apps[appId];
            const common = app?.appinfo?.common as Record<string, unknown> | undefined;
            if (common && common.releasestate === 'released' && String(common.type).toLowerCase() === 'game' && typeof common.name === 'string') {
              gamesToFilter.push({ name: String(common.name), appId });
            }
          }

          const filteredGames = filterGames(gamesToFilter, { whitelist, blacklist });

          if (filteredGames.length > 0) {
            yield* sessionStore.update((data) => ({
              ...data,
              freeGameIds: HashSet.fromIterable([...data.freeGameIds, ...filteredGames.map((g) => g.appId)]),
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
          freeGameIds: shouldReset ? HashSet.empty() : data.freeGameIds,
        };
      });
    }

    const semaphore = yield* RegistrationSemaphore;
    yield* semaphore.withPermits(1)(registerFreeGames(user));
  });
