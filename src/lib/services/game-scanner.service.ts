import { container } from '@vegapunk/core';
import { unionBy } from '@vegapunk/utilities/common';
import { isErrorLike, Result } from '@vegapunk/utilities/result';
import { sleep, waitUntil } from '@vegapunk/utilities/sleep';

import type SteamUser from 'steam-user';
import type CSteamUser from 'steamcommunity/classes/CSteamUser';
import type { GameContext, Session } from '../struct/Session';

const TIMEOUT_MESSAGE = 'Request timed out' as const;
const EXCLUDED_GAME_NAME = /\b(?:Beta|Demo|P(?:laytest|TS)|Public (?:Beta|Test)|Test|Unstable)\b/i;

export async function scanGames(session: Session): Promise<void> {
  const includedIds = session.getIncludedAppIds();
  const excludedIds = session.getExcludedAppIds();

  let timeoutId: NodeJS.Timeout | undefined;
  try {
    await waitUntil(async (release) => {
      if (session.isExpired) {
        return release();
      }

      const result = await Result.fromAsync(async () => {
        const userAppsData = await new Promise<{ apps: GameContext[] }>((resolve, reject) => {
          timeoutId = setTimeout(() => reject(new Error(TIMEOUT_MESSAGE)), 60_000);
          session.client
            .getUserOwnedApps(session.steamID, {
              includeAppInfo: true,
              includeFreeSub: true,
              skipUnvettedApps: false,
              includePlayedFreeGames: true,
            } as SteamUser.GetUserOwnedAppsOptions)
            .then(resolve)
            .catch(reject);
        });

        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }

        const combinedGames = unionBy(
          userAppsData.apps,
          [...includedIds].map((appid) => ({ appid, name: 'unknown' })),
          (game) => game.appid,
        );

        const filteredGames = combinedGames
          .filter((game) => {
            const isWhitelisted = includedIds.has(game.appid);
            const isBlacklisted = excludedIds.has(game.appid) || EXCLUDED_GAME_NAME.test(game.name);
            return isWhitelisted || !isBlacklisted;
          })
          .map((game) => ({ appid: game.appid, name: game.name }));

        // Clear and update the list to avoid duplicates on periodic scans
        session.ownedGameList.length = 0;
        session.ownedGameList.push(...filteredGames);
        release();
      });

      if (result.isErr()) {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }

        const error = result.unwrapErr();
        if (isErrorLike(error) && error.message !== TIMEOUT_MESSAGE) {
          container.logger.error(error, `GameScanner: ${session.username} error during scan`);
        }
        await sleep(10_000);
      }
    });
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function updateEnabledState(session: Session, steamUser: CSteamUser | null): void {
  if (typeof steamUser?.onlineState === 'string') {
    session.getState().setEnabled(steamUser.onlineState === 'offline');
  }
}
