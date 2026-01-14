import { ConfigContext, GameContext, UserContext } from './schemas';

export const RATE_LIMIT_MIN_MS = 1_800_000;
export const EXCLUDED_GAME_NAME_PATTERN = /\b(?:Beta|Demo|P(?:laytest|TS)|Public (?:Beta|Test)|Test|Unstable)\b/i;

export const userPreferences = (config: ConfigContext, user: UserContext, bannedIds: readonly number[] = []) => ({
  whitelist: new Set([...(config.whitelistGameIds || []), ...(user.whitelistGameIds || [])]),
  blacklist: new Set([...(config.blacklistGameIds || []), ...(user.blacklistGameIds || []), ...bannedIds]),
});

export const filterGames = (
  games: readonly GameContext[],
  {
    whitelist,
    blacklist,
    excludePatterns = true,
  }: {
    whitelist: ReadonlySet<number>;
    blacklist: ReadonlySet<number>;
    excludePatterns?: boolean;
  },
) =>
  games.filter((game) => {
    if (whitelist.has(game.appId)) return true;
    if (blacklist.has(game.appId)) return false;
    return !(excludePatterns && EXCLUDED_GAME_NAME_PATTERN.test(game.name));
  });

export const getFilteredGames = (games: readonly GameContext[], config: ConfigContext, user: UserContext, bannedIds: readonly number[] = []) =>
  filterGames(games, userPreferences(config, user, bannedIds));

export const parseAppIdsFromHtml = (html: string): number[] => {
  const matches = html.match(/data-ds-appid="([^"]+)"/g);
  if (!matches) return [];
  return [...new Set(matches.flatMap((m) => m.match(/\d+/g) || []).map(Number))];
};

export const getRateLimitSleep = (refreshGames: number) => Math.max(refreshGames, RATE_LIMIT_MIN_MS);
