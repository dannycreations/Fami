import { Array, Data, HashSet } from 'effect';

import type { ConfigContext, GameContext, UserContext } from './schemas';

export const RATE_LIMIT_MIN_MS = 1_800_000;
export const EXCLUDED_GAME_NAME_PATTERN = /\b(?:Beta|Demo|P(?:laytest|TS)|Public (?:Beta|Test)|Test|Unstable)\b/i;

export class UserPreferences extends Data.Class<{
  readonly whitelist: HashSet.HashSet<number>;
  readonly blacklist: HashSet.HashSet<number>;
}> {}

export const getUserPreferences = (
  config: ConfigContext,
  user: UserContext,
  bannedIds: HashSet.HashSet<number> = HashSet.empty(),
): UserPreferences => {
  const whitelist = HashSet.fromIterable([...(config.whitelistGameIds ?? []), ...(user.whitelistGameIds ?? [])]);
  const blacklist = HashSet.fromIterable([...(config.blacklistGameIds ?? []), ...(user.blacklistGameIds ?? [])]);

  return new UserPreferences({
    whitelist,
    blacklist: HashSet.union(blacklist, bannedIds),
  });
};

export interface FilterGamesOptions {
  readonly whitelist: HashSet.HashSet<number>;
  readonly blacklist: HashSet.HashSet<number>;
  readonly excludePatterns?: boolean;
}

export const filterGames = (games: ReadonlyArray<GameContext>, options: FilterGamesOptions): ReadonlyArray<GameContext> => {
  const { whitelist, blacklist, excludePatterns = true } = options;

  return Array.filter(games, (game) => {
    if (HashSet.has(whitelist, game.appId)) {
      return true;
    }

    if (HashSet.has(blacklist, game.appId)) {
      return false;
    }

    return !(excludePatterns && EXCLUDED_GAME_NAME_PATTERN.test(game.name));
  });
};

export const getFilteredGames = (
  games: ReadonlyArray<GameContext>,
  config: ConfigContext,
  user: UserContext,
  bannedIds: HashSet.HashSet<number> = HashSet.empty(),
): ReadonlyArray<GameContext> => filterGames(games, getUserPreferences(config, user, bannedIds));

export const parseAppIdsFromHtml = (html: string): ReadonlyArray<number> => {
  const matches = html.matchAll(/data-ds-appid="(\d+(?:,\d+)*)"/g);
  const ids = new Set<number>();

  for (const match of matches) {
    const rawIds = match[1].split(',');
    for (const id of rawIds) {
      const num = Number(id);
      if (!Number.isNaN(num)) {
        ids.add(num);
      }
    }
  }

  return Array.fromIterable(ids);
};

export const getRateLimitSleep = (refreshGames: number): number => Math.max(refreshGames, RATE_LIMIT_MIN_MS);
