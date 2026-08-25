import { Effect, HashSet } from 'effect';

import type { ConfigContext, GameContext, UserContext } from './schemas.js';

const RATE_LIMIT_MIN_MS = 1_800_000;
const EXCLUDED_GAME_NAME_PATTERN = /\b(?:Beta|Demo|P(?:laytest|TS)|Public (?:Beta|Test)|Test|Unstable)\b/i;

export const nowMillis: Effect.Effect<number> = Effect.clock.pipe(Effect.flatMap((clock) => clock.currentTimeMillis));

export interface GameFilter {
  readonly whitelist: HashSet.HashSet<number>;
  readonly blacklist: HashSet.HashSet<number>;
}

export const getUserPreferences = (config: ConfigContext, user: UserContext, bannedIds: HashSet.HashSet<number> = HashSet.empty()): GameFilter => {
  const whitelist = HashSet.fromIterable([...(config.whitelistGameIds ?? []), ...(user.whitelistGameIds ?? [])]);
  const blacklist = HashSet.fromIterable([...(config.blacklistGameIds ?? []), ...(user.blacklistGameIds ?? []), ...bannedIds]);

  return { whitelist, blacklist };
};

export const filterGames = (games: ReadonlyArray<GameContext>, filter: GameFilter): ReadonlyArray<GameContext> =>
  games.filter((game) => {
    const isWhitelisted = HashSet.has(filter.whitelist, game.appId);
    if (isWhitelisted) {
      return true;
    }

    const isBlacklisted = HashSet.has(filter.blacklist, game.appId);
    if (isBlacklisted) {
      return false;
    }

    return !EXCLUDED_GAME_NAME_PATTERN.test(game.name);
  });

export const parseAppIdsFromHtml = (html: string): ReadonlyArray<number> => {
  const ids = new Set<number>();

  for (const [, rawIds] of html.matchAll(/data-ds-appid="([\d,]+)"/g)) {
    for (const part of rawIds.split(',')) {
      const appId = Number.parseInt(part, 10);

      if (appId > 0) {
        ids.add(appId);
      }
    }
  }

  return Array.from(ids);
};

export const getRateLimitSleep = (refreshGames: number): number => Math.max(refreshGames, RATE_LIMIT_MIN_MS);
