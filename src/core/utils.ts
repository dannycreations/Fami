import { Data, HashSet } from 'effect';

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
  const whitelist = HashSet.beginMutation(HashSet.empty<number>());
  config.whitelistGameIds?.forEach((id) => HashSet.add(whitelist, id));
  user.whitelistGameIds?.forEach((id) => HashSet.add(whitelist, id));

  const blacklist = HashSet.beginMutation(HashSet.empty<number>());
  config.blacklistGameIds?.forEach((id) => HashSet.add(blacklist, id));
  user.blacklistGameIds?.forEach((id) => HashSet.add(blacklist, id));
  for (const id of bannedIds) HashSet.add(blacklist, id);

  return new UserPreferences({
    whitelist: HashSet.endMutation(whitelist),
    blacklist: HashSet.endMutation(blacklist),
  });
};

export interface FilterGamesOptions {
  readonly whitelist: HashSet.HashSet<number>;
  readonly blacklist: HashSet.HashSet<number>;
  readonly excludePatterns?: boolean;
}

export const filterGames = (games: ReadonlyArray<GameContext>, options: FilterGamesOptions): ReadonlyArray<GameContext> => {
  const { whitelist, blacklist, excludePatterns = true } = options;

  return games.filter((game) => {
    if (HashSet.has(whitelist, game.appId)) return true;
    if (HashSet.has(blacklist, game.appId)) return false;
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
  const ids = new Set<number>();
  const regex = /data-ds-appid="([\d,]+)"/g;

  for (const match of html.matchAll(regex)) {
    const val = match[1];
    if (val.includes(',')) {
      for (const part of val.split(',')) {
        const num = Number.parseInt(part, 10);
        if (!Number.isNaN(num)) ids.add(num);
      }
    } else {
      const num = Number.parseInt(val, 10);
      if (!Number.isNaN(num)) ids.add(num);
    }
  }

  return Array.from(ids);
};

export const getRateLimitSleep = (refreshGames: number): number => Math.max(refreshGames, RATE_LIMIT_MIN_MS);
