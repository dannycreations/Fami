import { unionBy } from '@vegapunk/utilities/common';
import { Effect } from 'effect';
import SteamUser from 'steam-user';

import { catchAndLogUnlessTimeout, RetryTimeoutPolicy } from '../core/errors';
import { ConfigStoreTag, SessionStore, UserContext } from '../core/schemas';
import { getFilteredGames, userPreferences } from '../core/utils';
import { SteamClientTag } from '../services/SteamService';

export const collectOwnGames = (user: UserContext) =>
  Effect.gen(function* () {
    const steamClient = yield* SteamClientTag;
    const configStore = yield* ConfigStoreTag;
    const sessionStore = yield* SessionStore;

    const steamId = yield* steamClient.steamID;
    if (!steamId) return;

    const configData = yield* configStore.get;
    const sessionData = yield* sessionStore.get;

    const { whitelist } = userPreferences(configData, user, sessionData.bannedGameIds);

    const options = {
      includeAppInfo: true,
      includeFreeSub: true,
      skipUnvettedApps: false,
      includePlayedFreeGames: true,
    } as SteamUser.GetUserOwnedAppsOptions;

    const apps = yield* steamClient.getUserOwnedApps(steamId, options).pipe(
      RetryTimeoutPolicy,
      Effect.map((r) => r.apps),
      catchAndLogUnlessTimeout(`${user.username} OwnGame scanning failed`, []),
    );

    const combinedGames = unionBy(
      apps.map((a) => ({ appId: a.appid, name: a.name || 'unknown' })),
      [...whitelist].map((appId) => ({ appId, name: 'unknown' })),
      (game) => game.appId,
    );

    const filteredGames = getFilteredGames(combinedGames, configData, user, sessionData.bannedGameIds);

    const newGames = filteredGames.filter((g) => !sessionData.ownedGameList.some((r) => r.appId === g.appId));

    if (newGames.length > 0) {
      yield* sessionStore.update((data) => ({
        ...data,
        ownedGameList: [...data.ownedGameList, ...newGames],
      }));
    }
  });
