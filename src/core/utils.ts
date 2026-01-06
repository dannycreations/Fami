import { Effect } from 'effect';

import { TIMEOUT_MESSAGE } from './constants';
import { GameContext } from './schemas';

export const EXCLUDED_GAME_NAME_PATTERN = /\b(?:Beta|Demo|P(?:laytest|TS)|Public (?:Beta|Test)|Test|Unstable)\b/i;

export const logErrorIfNotTimeout = (prefix: string) => (error: unknown) =>
  Effect.gen(function* (_) {
    if (error instanceof Error && error?.message !== TIMEOUT_MESSAGE) {
      yield* _(Effect.logError(`${prefix}: ${error?.message || 'Unknown error'}`, error));
    }
  });

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
    if (whitelist.has(game.appid)) return true;
    if (blacklist.has(game.appid)) return false;
    if (excludePatterns && EXCLUDED_GAME_NAME_PATTERN.test(game.name)) return false;
    return true;
  });
};

export const parseAppIdsFromHtml = (html: string): number[] => {
  const matches = html.match(/data-ds-appid="([^"]+)"/g);
  if (!matches) return [];
  return [...new Set(matches.flatMap((m) => m.match(/\d+/g) || []).map(Number))];
};
