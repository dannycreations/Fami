import { unionBy } from '@vegapunk/utilities/common';
import { Effect } from 'effect';
import SteamUser from 'steam-user';

import { GameContext, SessionData, UserContext } from '../schemas/Domain';
import { SteamClient } from './SteamService';
import { Store } from './StoreService';

const EXCLUDED_GAME_NAME = /\b(?:Beta|Demo|P(?:laytest|TS)|Public (?:Beta|Test)|Test|Unstable)\b/i;
const TIMEOUT_MESSAGE = 'Request timed out' as const;

export class GameScannerError extends Error {
  readonly _tag = 'GameScannerError';
  constructor(
    override readonly message: string,
    readonly originalError?: unknown,
  ) {
    super(message);
  }
}

export const scanGames = (
  store: Store<SessionData>,
  userContext: UserContext,
  globalWhitelist: readonly number[],
  globalBlacklist: readonly number[],
) =>
  Effect.gen(function* (_) {
    const steamClient = yield* _(SteamClient);
    const sessionData = yield* _(store.get);

    const includedIds = new Set([...globalWhitelist, ...(userContext.whitelistGameIds || [])]);
    const excludedIds = new Set([...globalBlacklist, ...(userContext.blacklistGameIds || []), ...sessionData.bannedGameIds]);

    const fetchApps = steamClient
      .getUserOwnedApps(steamClient.user.steamID!, {
        includeAppInfo: true,
        includeFreeSub: true,
        skipUnvettedApps: false,
        includePlayedFreeGames: true,
      } as SteamUser.GetUserOwnedAppsOptions)
      .pipe(
        Effect.retry({
          times: 3,
          while: (error) => error.message === TIMEOUT_MESSAGE,
        }),
      );

    const result = yield* _(fetchApps, Effect.either);

    if (result._tag === 'Left') {
      const error = result.left;
      if (error.message !== TIMEOUT_MESSAGE) {
        yield* _(Effect.logError(`GameScanner: ${userContext.username} error during scan: ${error.message}`));
      }

      yield* _(Effect.sleep('10 seconds'));
      return;
    }

    const newGames: GameContext[] = [];
    const combinedGames = unionBy(
      result.right.apps,
      [...includedIds].map((appid) => ({ appid, name: 'unknown' })),
      (game) => game.appid,
    );

    for (const game of combinedGames) {
      const isWhitelisted = includedIds.has(game.appid);
      const isBlacklisted = excludedIds.has(game.appid) || EXCLUDED_GAME_NAME.test(game.name);

      if (isWhitelisted || !isBlacklisted) {
        if (!sessionData.ownedGameList.some((r) => r.appid === game.appid)) {
          newGames.push({ appid: game.appid, name: game.name });
        }
      }
    }

    if (newGames.length > 0) {
      yield* _(
        store.update((data) => ({
          ...data,
          ownedGameList: [...data.ownedGameList, ...newGames],
        })),
      );
    }
  });
