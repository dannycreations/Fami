import { requestDefault } from '@vegapunk/request';
import { Effect } from 'effect';
import SteamUser from 'steam-user';

import { GameContext, SessionData, UserContext } from '../schemas/Domain';
import { SteamClient } from './SteamService';
import { Store } from './StoreService';

interface ProductInfo {
  appinfo?: {
    common?: {
      name: string;
      type: string;
      releasestate: string;
    };
  };
}

export class FreeGameError extends Error {
  readonly _tag = 'FreeGameError';
  constructor(
    override readonly message: string,
    readonly originalError?: unknown,
  ) {
    super(message);
  }
}

const TIMEOUT_MESSAGE = 'Request timed out' as const;

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
      catch: (error) => new FreeGameError('Failed to fetch HTML', error),
    }).pipe(
      Effect.retry({
        times: 3,
        while: (error) => error.message === TIMEOUT_MESSAGE,
      }),
    );

    const result = yield* _(fetchSearch, Effect.either);

    if (result._tag === 'Left') {
      const error = result.left;
      if (error.message !== TIMEOUT_MESSAGE) {
        yield* _(Effect.logError(`FreeGame: ${userContext.username} error during collection: ${error.message}`));
      }
      yield* _(Effect.sleep('10 seconds'));
    } else {
      const searchResult = result.right;
      if (searchResult.isOk()) {
        const { body } = searchResult.unwrap();
        const gameIdMatches = body.match(/data-ds-appid="([^"]+)"/g);

        if (gameIdMatches && gameIdMatches.length > 0) {
          const allAppIds = [...new Set(gameIdMatches.flatMap((m: string) => m.match(/\d+/g) || []).map(Number))];
          const appIdsToCheck = allAppIds.filter((id) => !claimExcludeIds.has(id) && !sessionData.freeGameIds.includes(id));

          if (appIdsToCheck.length > 0) {
            const productInfo = yield* _(
              steamClient.getProductInfo(appIdsToCheck, []),
              Effect.catchAll(() => Effect.succeed({ apps: null })),
            );

            if (productInfo && typeof productInfo.apps === 'object' && productInfo.apps !== null) {
              const newFreeGames: GameContext[] = [];
              const newFreeGameIds: number[] = [];

              for (const appid of appIdsToCheck) {
                const app = productInfo.apps[appid] as ProductInfo;
                const common = app?.appinfo?.common;

                if (!common) {
                  continue;
                }

                if (common.releasestate !== 'released' || common.type?.toLowerCase() !== 'game') {
                  continue;
                }

                if (!sessionData.freeGameIds.includes(appid)) {
                  newFreeGameIds.push(appid);
                  newFreeGames.push({ name: common.name, appid });
                }
              }

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
          if (sessionData.lastLoop >= 5) {
            yield* _(
              store.update((data) => ({
                ...data,
                lastPage: 1,
                forceRegister: true,
                freeGameIds: [],
              })),
            );
          }

          if (sessionData.freeGameLength === sessionData.freeGameList.length) {
            yield* _(store.update((data) => ({ ...data, lastLoop: data.lastLoop + 1 })));
          }

          yield* _(store.update((data) => ({ ...data, freeGameLength: data.freeGameList.length })));
        }
      } else {
        const error = searchResult.unwrapErr();
        if (error instanceof Error && error.message !== TIMEOUT_MESSAGE) {
          yield* _(Effect.logError(`FreeGame: ${userContext.username} error during collection: ${error.message}`));
        }
        yield* _(Effect.sleep('10 seconds'));
      }
    }

    yield* _(registrationSemaphore.withPermits(1)(registerFreeGames(store, userContext, refreshGames)));
  });

export const registerFreeGames = (store: Store<SessionData>, userContext: UserContext, refreshGames: number) =>
  Effect.gen(function* (_) {
    const steamClient = yield* _(SteamClient);
    const sessionData = yield* _(store.get);

    const isSufficient = sessionData.freeGameList.length >= 50 || sessionData.forceRegister;
    if (!isSufficient || sessionData.freeGameList.length === 0) return;

    const gamesToRegister = sessionData.freeGameList.slice(0, 50);
    const gameIdsToRegister = new Set(gamesToRegister.map((g) => g.appid));

    const result = yield* _(steamClient.requestFreeLicense([...gameIdsToRegister]), Effect.either);

    if (result._tag === 'Left') {
      const error = result.left;

      if (error.message !== TIMEOUT_MESSAGE) {
        yield* _(Effect.logError(`FreeGame: ${userContext.username} error during registration: ${error.message}`));
      }

      if (error?.eresult === SteamUser.EResult.RateLimitExceeded) {
        const waitMs = Math.max(refreshGames, 1_800_000);
        yield* _(Effect.logWarning(`FreeGame: ${userContext.username} Rate Limit Exceeded. Waiting ${waitMs / 60000}m...`));
        yield* _(Effect.sleep(`${waitMs} millis`));
      } else {
        yield* _(Effect.sleep('10 seconds'));
      }
      return;
    }

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
