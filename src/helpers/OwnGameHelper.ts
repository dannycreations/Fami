import { unionBy } from '@vegapunk/utilities/common';
import { Array, Effect, HashSet } from 'effect';

import { catchAndLogUnlessTimeout } from '../core/errors';
import { ConfigStoreTag, SessionStore, UserContext } from '../core/schemas';
import { getFilteredGames, getUserPreferences } from '../core/utils';
import { SteamClientTag } from '../services/SteamService';

import type SteamUser from 'steam-user';

export const collectOwnGames = (user: UserContext): Effect.Effect<void, never, SteamClientTag | ConfigStoreTag | SessionStore> =>
  Effect.gen(function* () {
    const steamClient = yield* SteamClientTag;
    const configStore = yield* ConfigStoreTag;
    const sessionStore = yield* SessionStore;

    const steamId = yield* steamClient.steamID;
    if (!steamId) {
      return;
    }

    const configData = yield* configStore.get;
    const sessionData = yield* sessionStore.get;

    const { whitelist } = getUserPreferences(configData, user, sessionData.bannedGameIds);

    const options = {
      includeFreeSub: true,
      includePlayedFreeGames: true,
    } satisfies SteamUser.GetUserOwnedAppsOptions;

    const apps = yield* steamClient.getUserOwnedApps(steamId, options).pipe(
      Effect.map((r) => r.apps),
      catchAndLogUnlessTimeout(`${user.username} OwnGame scanning failed`, []),
    );

    const ownedIds = HashSet.fromIterable(Array.map(sessionData.ownedGameList, (g) => g.appId));

    const combinedGames = unionBy(
      Array.map(apps, (a) => ({ appId: a.appid, name: a.name || 'unknown' })),
      Array.map([...whitelist], (appId) => ({ appId, name: 'unknown' })),
      (game: { readonly appId: number }) => game.appId,
    );

    const filteredGames = getFilteredGames(combinedGames, configData, user, sessionData.bannedGameIds);

    const newGames = Array.filter(filteredGames, (g) => !HashSet.has(ownedIds, g.appId));

    if (newGames.length > 0) {
      yield* sessionStore.update((data) => ({
        ...data,
        ownedGameList: [...data.ownedGameList, ...newGames],
      }));
    }
  });
