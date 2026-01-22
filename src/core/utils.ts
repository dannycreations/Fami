import { Array, Data, HashSet } from 'effect';

import type { ConfigContext, GameContext, UserContext } from './schemas';

export const RATE_LIMIT_MIN_MS = 1_800_000;
export const EXCLUDED_GAME_NAME_PATTERN = /\b(?:Beta|Demo|P(?:laytest|TS)|Public (?:Beta|Test)|Test|Unstable)\b/i;

export class UserPreferences extends Data.Class<{
  readonly whitelist: HashSet.HashSet<number>;
  readonly blacklist: HashSet.HashSet<number>;
}> {}

export const getUserPreferences = (config: ConfigContext, user: UserContext, bannedIds: ReadonlyArray<number> = []): UserPreferences => {
  const whitelist = HashSet.fromIterable([...(config.whitelistGameIds ?? []), ...(user.whitelistGameIds ?? [])]);
  const blacklist = HashSet.fromIterable([...(config.blacklistGameIds ?? []), ...(user.blacklistGameIds ?? []), ...bannedIds]);

  return new UserPreferences({ whitelist, blacklist });
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
  bannedIds: ReadonlyArray<number> = [],
): ReadonlyArray<GameContext> => filterGames(games, getUserPreferences(config, user, bannedIds));

export const parseAppIdsFromHtml = (html: string): ReadonlyArray<number> => {
  const matches = html.match(/data-ds-appid="([^"]+)"/g);
  if (!matches) {
    return [];
  }

  const extractedIds = Array.flatMap(matches, (match) => match.match(/\d+/g) || []);
  const numericIds = Array.map(extractedIds, Number);

  return Array.dedupe(numericIds);
};

export const getRateLimitSleep = (refreshGames: number): number => Math.max(refreshGames, RATE_LIMIT_MIN_MS);
