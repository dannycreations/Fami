import { ConfigContext, GameContext, UserContext } from './schemas';

export const EXCLUDED_GAME_NAME_PATTERN = /\b(?:Beta|Demo|P(?:laytest|TS)|Public (?:Beta|Test)|Test|Unstable)\b/i;

export const filterGames = (
  games: readonly GameContext[],
  options: {
    whitelist?: ReadonlySet<number>;
    blacklist?: ReadonlySet<number>;
    excludePatterns?: boolean;
  },
) => {
  const { whitelist = new Set<number>(), blacklist = new Set<number>(), excludePatterns = true } = options;

  return games.filter((game) => {
    if (whitelist.has(game.appId)) return true;
    if (blacklist.has(game.appId)) return false;
    if (excludePatterns && EXCLUDED_GAME_NAME_PATTERN.test(game.name)) return false;
    return true;
  });
};

export const userPreferences = (config: ConfigContext, user: UserContext, bannedIds: readonly number[] = []) => {
  const whitelist = new Set([...(config.whitelistGameIds || []), ...(user.whitelistGameIds || [])]);
  const blacklist = new Set([...(config.blacklistGameIds || []), ...(user.blacklistGameIds || []), ...bannedIds]);
  return { whitelist, blacklist };
};

export const parseAppIdsFromHtml = (html: string): number[] => {
  const matches = html.match(/data-ds-appid="([^"]+)"/g);
  if (!matches) return [];
  return [...new Set(matches.flatMap((m) => m.match(/\d+/g) || []).map(Number))];
};
