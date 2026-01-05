import { requestDefault } from '@vegapunk/request';
import { Effect } from 'effect';
import SteamUser from 'steam-user';

import { DEFAULT_SLEEP_DURATION, RATE_LIMIT_MIN_MS, TIMEOUT_MESSAGE } from '../core/constants';
import { FreeGameError } from '../core/errors';
import { GameContext, SessionData, UserContext } from '../core/schemas';
import { filterGames, parseAppIdsFromHtml } from '../core/utils';
import { SteamClient, SteamRetryPolicy } from './SteamService';
import { Store } from './StoreService';

const MAX_FREE_GAMES_BATCH = 50;

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

    const fetchSearch = Effect.tryPromise({
      try: () =>
        requestDefault({
          url: 'https://store.steampowered.com/search/results',
          searchParams: {
            sort_by: 'Released_DESC',
            force_infinite: 1,
            maxprice: 'free',
            category1: '998,10',
            os: 'win',
            page: sessionData.lastPage,
          },
          retry: -1,
        }),
      catch: (error) => new FreeGameError({ message: 'Failed to fetch HTML', originalError: error }),
    }).pipe(Effect.retry(SteamRetryPolicy));

    yield* _(
      fetchSearch,
      Effect.tap((searchResult) =>
        Effect.gen(function* (_) {
          if (!searchResult.isOk()) {
            const error = searchResult.unwrapErr();
            if (error instanceof Error && error.message !== TIMEOUT_MESSAGE) {
              yield* _(Effect.logError(`FreeGame: ${userContext.username} error during collection: ${error.message}`));
            }
            return yield* _(Effect.sleep(DEFAULT_SLEEP_DURATION));
          }

          const { body } = searchResult.unwrap();
          const allAppIds = parseAppIdsFromHtml(body);

          if (allAppIds.length > 0) {
            const appIdsToCheck = allAppIds.filter((id) => !claimExcludeIds.has(id) && !sessionData.freeGameIds.includes(id));

            if (appIdsToCheck.length > 0) {
              const productInfo = yield* _(
                steamClient.getProductInfo(appIdsToCheck, []),
                Effect.catchAll(() => Effect.succeed({ apps: null })),
              );

              if (productInfo && typeof productInfo.apps === 'object' && productInfo.apps !== null) {
                const candidateGames: GameContext[] = [];
                for (const appid of appIdsToCheck) {
                  const app = productInfo.apps[appid];
                  const common = app?.appinfo?.common;
                  if (common) {
                    candidateGames.push({ name: common.name, appid });
                  }
                }

                const filteredGames = filterGames(candidateGames, {
                  blacklist: claimExcludeIds,
                });

                const newFreeGames = filteredGames.filter((g) => {
                  const app = productInfo.apps[g.appid];
                  const common = app?.appinfo?.common;
                  return common?.releasestate === 'released' && common?.type?.toLowerCase() === 'game' && !sessionData.freeGameIds.includes(g.appid);
                });

                const newFreeGameIds = newFreeGames.map((g) => g.appid);

                if (newFreeGames.length > 0) {
                  yield* _(
                    store.update((data) => ({
                      ...data,
                      freeGameIds: [...data.freeGameIds, ...newFreeGameIds],
                      freeGameList: [...data.freeGameList, ...newFreeGames],
                    })),
                  );
                }
              }
            }
            yield* _(store.update((data) => ({ ...data, lastPage: data.lastPage + 1 })));
          } else {
            const currentData = yield* _(store.get);
            if (currentData.lastLoop >= 5) {
              yield* _(
                store.update((data) => ({
                  ...data,
                  lastPage: 1,
                  forceRegister: true,
                  freeGameIds: [],
                })),
              );
            }

            if (currentData.freeGameLength === currentData.freeGameList.length) {
              yield* _(store.update((data) => ({ ...data, lastLoop: data.lastLoop + 1 })));
            }

            yield* _(store.update((data) => ({ ...data, freeGameLength: data.freeGameList.length })));
          }
        }),
      ),
      Effect.catchAll((error) =>
        Effect.gen(function* (_) {
          if (error.message !== TIMEOUT_MESSAGE) {
            yield* _(Effect.logError(`FreeGame: ${userContext.username} error during collection: ${error.message}`));
          }
          yield* _(Effect.sleep(DEFAULT_SLEEP_DURATION));
        }),
      ),
    );

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
      Effect.catchAll((error) =>
        Effect.gen(function* (_) {
          if (error.message !== TIMEOUT_MESSAGE) {
            yield* _(Effect.logError(`FreeGame: ${userContext.username} error during registration: ${error.message}`));
          }

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
