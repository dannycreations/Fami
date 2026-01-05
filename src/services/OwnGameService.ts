import { unionBy } from '@vegapunk/utilities/common';
import { Effect } from 'effect';
import SteamUser from 'steam-user';

import { DEFAULT_SLEEP_DURATION, TIMEOUT_MESSAGE } from '../core/constants';
import { SessionData, UserContext } from '../core/schemas';
import { filterGames } from '../core/utils';
import { SteamClient, SteamRetryPolicy } from './SteamService';
import { Store } from './StoreService';

export const collectOwnGames = (
  store: Store<SessionData>,
  userContext: UserContext,
  globalWhitelist: readonly number[],
  globalBlacklist: readonly number[],
) =>
  Effect.gen(function* (_) {
    const steamClient = yield* _(SteamClient);
    const sid = yield* _(steamClient.steamID);
    if (!sid) return;

    const sessionData = yield* _(store.get);

    const includedIds = new Set([...globalWhitelist, ...(userContext.whitelistGameIds || [])]);
    const excludedIds = new Set([...globalBlacklist, ...(userContext.blacklistGameIds || []), ...sessionData.bannedGameIds]);

    const fetchApps = steamClient
      .getUserOwnedApps(sid, {
        includeAppInfo: true,
        includeFreeSub: true,
        skipUnvettedApps: false,
        includePlayedFreeGames: true,
      } as SteamUser.GetUserOwnedAppsOptions)
      .pipe(Effect.retry(SteamRetryPolicy));

    const apps = yield* _(
      fetchApps,
      Effect.map((r) => r.apps),
      Effect.catchAll((error) =>
        Effect.gen(function* (_) {
          if (error.message !== TIMEOUT_MESSAGE) {
            yield* _(Effect.logError(`GameScanner: ${userContext.username} error during scan: ${error.message}`));
          }

          yield* _(Effect.sleep(DEFAULT_SLEEP_DURATION));
          return yield* _(Effect.fail(error));
        }),
      ),
      Effect.orElseSucceed(() => []),
    );

    const combinedGames = unionBy(
      apps,
      [...includedIds].map((appid) => ({ appid, name: 'unknown' })),
      (game) => game.appid,
    );

    const filteredGames = filterGames(combinedGames, {
      whitelist: includedIds,
      blacklist: excludedIds,
    });

    const newGames = filteredGames.filter((g) => !sessionData.ownedGameList.some((r) => r.appid === g.appid));

    if (newGames.length > 0) {
      yield* _(
        store.update((data) => ({
          ...data,
          ownedGameList: [...data.ownedGameList, ...newGames],
        })),
      );
    }
  });
