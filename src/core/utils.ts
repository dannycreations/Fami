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
  const configWhitelist = config.whitelistGameIds ?? [];
  const userWhitelist = user.whitelistGameIds ?? [];
  const whitelist = HashSet.fromIterable([...configWhitelist, ...userWhitelist]);

  const configBlacklist = config.blacklistGameIds ?? [];
  const userBlacklist = user.blacklistGameIds ?? [];
  const blacklist = HashSet.fromIterable([...configBlacklist, ...userBlacklist, ...bannedIds]);

  return new UserPreferences({ whitelist, blacklist });
};

export interface FilterGamesOptions {
  readonly whitelist: HashSet.HashSet<number>;
  readonly blacklist: HashSet.HashSet<number>;
  readonly excludePatterns?: boolean;
}

export const filterGames = (games: ReadonlyArray<GameContext>, options: FilterGamesOptions): ReadonlyArray<GameContext> => {
  const { whitelist, blacklist, excludePatterns = true } = options;

  return games.filter((game) => {
    const isWhitelisted = HashSet.has(whitelist, game.appId);
    if (isWhitelisted) {
      return true;
    }

    const isBlacklisted = HashSet.has(blacklist, game.appId);
    if (isBlacklisted) {
      return false;
    }

    const isExcludedByPattern = excludePatterns && EXCLUDED_GAME_NAME_PATTERN.test(game.name);
    if (isExcludedByPattern) {
      return false;
    }

    return true;
  });
};

export const parseAppIdsFromHtml = (html: string): ReadonlyArray<number> => {
  const ids = new Set<number>();
  const regex = /data-ds-appid="([\d,]+)"/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    const val = match[1];
    const isSingleId = !val.includes(',');

    if (isSingleId) {
      const num = Number.parseInt(val, 10);

      if (num > 0) {
        ids.add(num);
      }

      continue;
    }

    const parts = val.split(',');

    for (const part of parts) {
      const num = Number.parseInt(part, 10);

      if (num <= 0) {
        continue;
      }

      ids.add(num);
    }
  }

  return Array.from(ids);
};

export const getRateLimitSleep = (refreshGames: number): number => Math.max(refreshGames, RATE_LIMIT_MIN_MS);
