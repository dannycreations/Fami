import { unionBy } from '@vegapunk/utilities/common';
import { Effect } from 'effect';
import SteamUser from 'steam-user';

import { catchAndLogUnlessTimeout } from '../core/errors';
import { ConfigStore, SessionStore, UserContext } from '../core/schemas';
import { filterGames } from '../core/utils';
import { SteamClient, SteamRetryPolicy } from '../services/SteamService';

export const collectOwnGames = (user: UserContext) =>
  Effect.gen(function* (_) {
    const steamClient = yield* _(SteamClient);
    const configStore = yield* _(ConfigStore);
    const sessionStore = yield* _(SessionStore);

    const steamId = yield* _(steamClient.steamID);
    if (!steamId) return;

    const configData = yield* _(configStore.get);
    const sessionData = yield* _(sessionStore.get);

    const includedIds = new Set([...(configData.whitelistGameIds || []), ...(user.whitelistGameIds || [])]);
    const excludedIds = new Set([...(configData.blacklistGameIds || []), ...(user.blacklistGameIds || []), ...sessionData.bannedGameIds]);

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
      catchAndLogUnlessTimeout(`GameScanner: ${user.username} error during scan`, []),
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
        sessionStore.update((data) => ({
          ...data,
          ownedGameList: [...data.ownedGameList, ...newGames],
        })),
      );
    }
  });
