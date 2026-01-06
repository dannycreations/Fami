import { requestDefault } from '@vegapunk/request';
import { Effect } from 'effect';
import SteamUser from 'steam-user';

import { RATE_LIMIT_MIN_MS } from '../core/constants';
import { catchAndLogUnlessTimeout, FreeGameError } from '../core/errors';
import { SessionContext, UserContext } from '../core/schemas';
import { filterGames, parseAppIdsFromHtml } from '../core/utils';
import { SteamClient, SteamRetryPolicy } from './SteamService';
import { Store } from './StoreService';

import type { ConfigContext } from '../core/schemas';

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
  user: UserContext,
  configStore: Store<ConfigContext>,
  sessionStore: Store<SessionContext>,
  registrationSemaphore: Effect.Semaphore,
) =>
  Effect.gen(function* (_) {
    const steamClient = yield* _(SteamClient);
    const configData = yield* _(configStore.get);
    const sessionData = yield* _(sessionStore.get);

    const claimExcludeIds = new Set([
      ...(configData.blacklistGameIds || []),
      ...(user.blacklistGameIds || []),
      ...sessionData.bannedGameIds,
      ...sessionData.ownedGameList.map((g) => g.appId),
    ]);

    const result = yield* _(
      fetchSearchPage(sessionData.lastPage),
      Effect.map((res) => parseAppIdsFromHtml(res.body)),
      catchAndLogUnlessTimeout(`FreeGame: ${user.username} error during collection`, []),
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
            .map((appId) => ({ appId, common: productInfo.apps![appId]?.appinfo?.common }))
            .filter(({ common }) => common && common.releasestate === 'released' && common.type?.toLowerCase() === 'game')
            .map(({ appId, common }) => ({ name: common!.name, appId }));

          const filteredGames = filterGames(newFreeGames, { blacklist: claimExcludeIds });

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
          // If no new games found on current page, check if we've stalled for too long
          const isStalled = data.freeGameLength === data.freeGameList.length;
          const nextLoop = isStalled ? data.lastLoop + 1 : data.lastLoop;
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

    yield* _(registrationSemaphore.withPermits(1)(registerFreeGames(user, configStore, sessionStore)));
  });

export const registerFreeGames = (user: UserContext, configStore: Store<ConfigContext>, sessionStore: Store<SessionContext>) =>
  Effect.gen(function* (_) {
    const steamClient = yield* _(SteamClient);
    const configData = yield* _(configStore.get);
    const sessionData = yield* _(sessionStore.get);

    const isSufficient = sessionData.freeGameList.length >= MAX_FREE_GAMES_BATCH || sessionData.forceRegister;
    if (!isSufficient || sessionData.freeGameList.length === 0) return;

    const gamesToRegister = sessionData.freeGameList.slice(0, MAX_FREE_GAMES_BATCH);
    const gameIdsToRegister = new Set(gamesToRegister.map((g) => g.appId));

    yield* _(
      steamClient.requestFreeLicense([...gameIdsToRegister]),
      Effect.catchAll((error) =>
        Effect.gen(function* (_) {
          if (error?.eresult === SteamUser.EResult.RateLimitExceeded) {
            const waitMs = Math.max(configData.refreshGames, RATE_LIMIT_MIN_MS);
            yield* _(Effect.logWarning(`FreeGame: ${user.username} Rate Limit Exceeded. Waiting ${waitMs / 60000}m...`));
            yield* _(Effect.sleep(`${waitMs} millis`));
          }
          return yield* _(Effect.fail(error));
        }),
      ),
      Effect.retry(SteamRetryPolicy),
      catchAndLogUnlessTimeout(`FreeGame: ${user.username} error during registration`, undefined),
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
