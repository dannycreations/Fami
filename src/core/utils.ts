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
  const whitelist = HashSet.beginMutation(HashSet.fromIterable(config.whitelistGameIds ?? []));
  if (user.whitelistGameIds) {
    for (const id of user.whitelistGameIds) HashSet.add(whitelist, id);
  }

  const blacklist = HashSet.beginMutation(HashSet.fromIterable(config.blacklistGameIds ?? []));
  if (user.blacklistGameIds) {
    for (const id of user.blacklistGameIds) HashSet.add(blacklist, id);
  }
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
  let match: RegExpExecArray | null;
  const regex = /data-ds-appid="([\d,]+)"/g;

  while ((match = regex.exec(html)) !== null) {
    let start = 0;
    const val = match[1];
    while (true) {
      const commaIndex = val.indexOf(',', start);
      const part = commaIndex === -1 ? val.slice(start) : val.slice(start, commaIndex);
      const num = parseInt(part, 10);
      if (!Number.isNaN(num)) ids.add(num);
      if (commaIndex === -1) break;
      start = commaIndex + 1;
    }
  }

  return Array.from(ids);
};

export const getRateLimitSleep = (refreshGames: number): number => Math.max(refreshGames, RATE_LIMIT_MIN_MS);
