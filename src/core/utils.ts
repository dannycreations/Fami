import { ConfigContext, GameContext, UserContext } from './schemas';

export const RATE_LIMIT_MIN_MS = 1_800_000;
export const EXCLUDED_GAME_NAME_PATTERN = /\b(?:Beta|Demo|P(?:laytest|TS)|Public (?:Beta|Test)|Test|Unstable)\b/i;

export const userPreferences = (config: ConfigContext, user: UserContext, bannedIds: readonly number[] = []) => {
  const whitelist = new Set([...(config.whitelistGameIds ?? []), ...(user.whitelistGameIds ?? [])]);
  const blacklist = new Set([...(config.blacklistGameIds ?? []), ...(user.blacklistGameIds ?? []), ...bannedIds]);

  return { whitelist, blacklist } as const;
};

export const filterGames = (
  games: readonly GameContext[],
  options: {
    readonly whitelist: ReadonlySet<number>;
    readonly blacklist: ReadonlySet<number>;
    readonly excludePatterns?: boolean;
  },
) => {
  const { whitelist, blacklist, excludePatterns = true } = options;

  return games.filter((game) => {
    if (whitelist.has(game.appId)) {
      return true;
    }

    if (blacklist.has(game.appId)) {
      return false;
    }

    return !(excludePatterns && EXCLUDED_GAME_NAME_PATTERN.test(game.name));
  });
};

export const getFilteredGames = (games: readonly GameContext[], config: ConfigContext, user: UserContext, bannedIds: readonly number[] = []) =>
  filterGames(games, userPreferences(config, user, bannedIds));

export const parseAppIdsFromHtml = (html: string) => {
  const matches = html.match(/data-ds-appid="([^"]+)"/g);
  if (!matches) return [];
  return [...new Set(matches.flatMap((m) => m.match(/\d+/g) || []).map(Number))];
};

export const getRateLimitSleep = (refreshGames: number): number => Math.max(refreshGames, RATE_LIMIT_MIN_MS);
