import { unionBy } from '@vegapunk/utilities/common';
import { Effect, HashSet } from 'effect';

import { catchAndLogUnlessTimeout } from '../core/errors.js';
import { ConfigStoreTag, getOwnedGameIds, SessionStore, UserContext } from '../core/schemas.js';
import { filterGames, getUserPreferences, nowMillis } from '../core/utils.js';
import { SteamClientTag } from '../services/SteamService.js';

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

    const now = yield* nowMillis;
    const isCooldown = now - sessionData.lastOwnGamesScan < configData.refreshGames;

    if (isCooldown) {
      return;
    }

    const preferences = getUserPreferences(configData, user, sessionData.bannedGameIds);

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

    const whitelistGames = Array.from(preferences.whitelist).map((appId) => ({
      appId,
      name: 'unknown',
    }));

    const combinedGames = unionBy(ownedGames, whitelistGames, (game: { readonly appId: number }) => game.appId);

    const filteredGames = filterGames(combinedGames, preferences);

    const ownedGameIds = getOwnedGameIds(sessionData);

    const newGames = filteredGames.filter((g) => !HashSet.has(ownedGameIds, g.appId));

    const hasNewGames = newGames.length > 0;

    if (!hasNewGames) {
      return;
    }

    yield* sessionStore.update((data) => ({
      ...data,
      ownedGameList: [...data.ownedGameList, ...newGames],
      lastOwnGamesScan: now,
    }));
  });
