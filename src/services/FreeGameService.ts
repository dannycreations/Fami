import { requestDefault } from '@vegapunk/request';
import { Effect } from 'effect';
import SteamUser from 'steam-user';

import { DEFAULT_SLEEP_DURATION, RATE_LIMIT_MIN_MS } from '../core/constants';
import { FreeGameError } from '../core/errors';
import { SessionData, UserContext } from '../core/schemas';
import { filterGames, logErrorIfNotTimeout, parseAppIdsFromHtml } from '../core/utils';
import { SteamClient, SteamRetryPolicy } from './SteamService';
import { Store } from './StoreService';

const MAX_FREE_GAMES_BATCH = 50;

const fetchSearchPage = (page: number) =>
  Effect.tryPromise({
    try: () =>
      requestDefault({
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
      }),
    catch: (error) => new FreeGameError({ message: 'Failed to fetch HTML', originalError: error }),
  }).pipe(
    Effect.flatMap((res) => (res.isOk() ? Effect.succeed(res.unwrap()) : Effect.fail(new FreeGameError({ message: 'Response not OK' })))),
    Effect.retry(SteamRetryPolicy),
  );

export const collectFreeGames = (
  store: Store<SessionData>,
  userContext: UserContext,
  globalBlacklist: readonly number[],
  registrationSemaphore: Effect.Semaphore,
  refreshGames: number,
) =>
  Effect.gen(function* (_) {
    const steamClient = yield* _(SteamClient);
    const sessionData = yield* _(store.get);

    const claimExcludeIds = new Set([
      ...globalBlacklist,
      ...(userContext.blacklistGameIds || []),
      ...sessionData.bannedGameIds,
      ...sessionData.ownedGameList.map((g) => g.appid),
    ]);

    const result = yield* _(
      fetchSearchPage(sessionData.lastPage),
      Effect.map((res) => parseAppIdsFromHtml(res.body)),
      Effect.tapError(logErrorIfNotTimeout(`FreeGame: ${userContext.username} error during collection`)),
      Effect.catchAll(() => Effect.as(Effect.sleep(DEFAULT_SLEEP_DURATION), [])),
    );

    if (result.length > 0) {
      const appIdsToCheck = result.filter((id) => !claimExcludeIds.has(id) && !sessionData.freeGameIds.includes(id));

      if (appIdsToCheck.length > 0) {
        const productInfo = yield* _(
          steamClient.getProductInfo(appIdsToCheck, []),
          Effect.catchAll(() => Effect.succeed({ apps: null })),
        );

        if (productInfo?.apps && typeof productInfo.apps === 'object') {
          const newFreeGames = appIdsToCheck
            .map((appid) => ({ appid, common: productInfo.apps![appid]?.appinfo?.common }))
            .filter(({ common }) => common && common.releasestate === 'released' && common.type?.toLowerCase() === 'game')
            .map(({ appid, common }) => ({ name: common!.name, appid }));

          const filteredGames = filterGames(newFreeGames, { blacklist: claimExcludeIds });

          if (filteredGames.length > 0) {
            yield* _(
              store.update((data) => ({
                ...data,
                freeGameIds: [...data.freeGameIds, ...filteredGames.map((g) => g.appid)],
                freeGameList: [...data.freeGameList, ...filteredGames],
              })),
            );
          }
        }
      }
      yield* _(store.update((data) => ({ ...data, lastPage: data.lastPage + 1 })));
    } else {
      yield* _(
        store.update((data) => {
          const nextLoop = data.freeGameLength === data.freeGameList.length ? data.lastLoop + 1 : data.lastLoop;
          const shouldReset = nextLoop >= 5;

          return {
            ...data,
            lastLoop: shouldReset ? 0 : nextLoop,
            lastPage: shouldReset ? 1 : data.lastPage,
            forceRegister: shouldReset ? true : data.forceRegister,
            freeGameIds: shouldReset ? [] : data.freeGameIds,
            freeGameLength: data.freeGameList.length,
          };
        }),
      );
    }

    yield* _(registrationSemaphore.withPermits(1)(registerFreeGames(store, userContext, refreshGames)));
  });

export const registerFreeGames = (store: Store<SessionData>, userContext: UserContext, refreshGames: number) =>
  Effect.gen(function* (_) {
    const steamClient = yield* _(SteamClient);
    const sessionData = yield* _(store.get);

    const isSufficient = sessionData.freeGameList.length >= MAX_FREE_GAMES_BATCH || sessionData.forceRegister;
    if (!isSufficient || sessionData.freeGameList.length === 0) return;

    const gamesToRegister = sessionData.freeGameList.slice(0, MAX_FREE_GAMES_BATCH);
    const gameIdsToRegister = new Set(gamesToRegister.map((g) => g.appid));

    yield* _(
      steamClient.requestFreeLicense([...gameIdsToRegister]),
      Effect.tapError(logErrorIfNotTimeout(`FreeGame: ${userContext.username} error during registration`)),
      Effect.catchAll((error) =>
        Effect.gen(function* (_) {
          if (error?.eresult === SteamUser.EResult.RateLimitExceeded) {
            const waitMs = Math.max(refreshGames, RATE_LIMIT_MIN_MS);
            yield* _(Effect.logWarning(`FreeGame: ${userContext.username} Rate Limit Exceeded. Waiting ${waitMs / 60000}m...`));
            yield* _(Effect.sleep(`${waitMs} millis`));
          } else {
            yield* _(Effect.sleep(DEFAULT_SLEEP_DURATION));
          }
          return yield* _(Effect.fail(error));
        }),
      ),
      Effect.retry(SteamRetryPolicy),
      Effect.ignore,
    );

    yield* _(
      Effect.logInfo(`${userContext.username} added ${gamesToRegister.length}/${sessionData.freeGameList.length}/${sessionData.lastPage} new games`),
    );

    yield* _(
      store.update((data) => ({
        ...data,
        freeGameList: data.freeGameList.filter((g) => !gameIdsToRegister.has(g.appid)),
        lastLoop: 0,
        forceRegister: false,
      })),
    );
  });
