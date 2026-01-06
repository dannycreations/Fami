import { unionBy } from '@vegapunk/utilities/common';
import { Effect } from 'effect';
import SteamUser from 'steam-user';

import { catchAndLogUnlessTimeout } from '../core/errors';
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
    const steamId = yield* _(steamClient.steamID);
    if (!steamId) return;

    const sessionData = yield* _(store.get);

    const includedIds = new Set([...globalWhitelist, ...(userContext.whitelistGameIds || [])]);
    const excludedIds = new Set([...globalBlacklist, ...(userContext.blacklistGameIds || []), ...sessionData.bannedGameIds]);

    const fetchApps = steamClient
      .getUserOwnedApps(steamId, {
        includeAppInfo: true,
        includeFreeSub: true,
        skipUnvettedApps: false,
        includePlayedFreeGames: true,
      } as SteamUser.GetUserOwnedAppsOptions)
      .pipe(Effect.retry(SteamRetryPolicy));

    const apps = yield* _(
      fetchApps,
      Effect.map((r) => r.apps),
      catchAndLogUnlessTimeout(`GameScanner: ${userContext.username} error during scan`, []),
    );

    const combinedGames = unionBy(
      apps.map((a) => ({ appId: a.appid, name: a.name || 'unknown' })),
      [...includedIds].map((appId) => ({ appId, name: 'unknown' })),
      (game) => game.appId,
    );

    const filteredGames = filterGames(combinedGames, {
      whitelist: includedIds,
      blacklist: excludedIds,
    });

    const newGames = filteredGames.filter((g) => !sessionData.ownedGameList.some((r) => r.appId === g.appId));

    if (newGames.length > 0) {
      yield* _(
        store.update((data) => ({
          ...data,
          ownedGameList: [...data.ownedGameList, ...newGames],
        })),
      );
    }
  });
