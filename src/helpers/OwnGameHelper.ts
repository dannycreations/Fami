import { unionBy } from '@vegapunk/utilities/common';
import { Effect, HashSet } from 'effect';

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
    const hasSteamId = !!steamId;

    if (!hasSteamId) {
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
      Effect.map((r) => r.apps || []),
      catchAndLogUnlessTimeout(`${user.username} OwnGame scanning failed`, []),
    );

    const ownedGames = apps.map((a) => ({
      appId: a.appid,
      name: a.name || 'unknown',
    }));

    const whitelistGames = Array.from(whitelist).map((appId) => ({
      appId,
      name: 'unknown',
    }));

    const combinedGames = unionBy(ownedGames, whitelistGames, (game: { readonly appId: number }) => game.appId);

    const filteredGames = getFilteredGames(combinedGames, configData, user, sessionData.bannedGameIds);

    const newGames = filteredGames.filter((g) => !HashSet.has(sessionData.ownedGameIds, g.appId));

    const hasNewGames = newGames.length > 0;

    if (!hasNewGames) {
      return;
    }

    yield* sessionStore.update((data) => ({
      ...data,
      ownedGameList: [...data.ownedGameList, ...newGames],
      ownedGameIds: HashSet.fromIterable([...data.ownedGameIds, ...newGames.map((g) => g.appId)]),
    }));
  });
