import { container } from '@vegapunk/core';
import { isObjectLike, unionBy } from '@vegapunk/utilities/common';
import { isErrorLike, Result } from '@vegapunk/utilities/result';
import { sleep, waitForEach, waitUntil } from '@vegapunk/utilities/sleep';

import type SteamUser from 'steam-user';
import type { GameContext, Session } from '../struct/Session';

const TIMEOUT_MESSAGE = 'Request timed out' as const;
const EXCLUDED_GAME_NAME = /\b(?:Beta|Demo|P(?:laytest|TS)|Public (?:Beta|Test)|Test|Unstable)\b/i;

export async function scanGames(session: Session): Promise<void> {
  const clientConfig = container.client.config;
  const includedIds = new Set([...clientConfig.whitelistGameIds, ...session.whitelistGameIds]);
  const excludedIds = new Set([
    ...clientConfig.blacklistGameIds,
    ...session.blacklistGameIds,
    ...session.bannedGameIds,
    ...session.ownedGameList.map((game) => game.appid),
  ]);

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

        await waitForEach(combinedGames, (game) => {
          const isWhitelisted = includedIds.has(game.appid);
          const isBlacklisted = excludedIds.has(game.appid) || EXCLUDED_GAME_NAME.test(game.name);
          if (!isWhitelisted && isBlacklisted) {
            return;
          }
          session.ownedGameList.push({ appid: game.appid, name: game.name });
        });
        release();
      });

      if (result.isErr()) {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }

        const error = result.unwrapErr();
        if (isErrorLike(error) && error.message !== TIMEOUT_MESSAGE) {
          container.logger.error(error, `[GameScanner] ${session.username} error during scan.`);
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

export function updateEnabledState(session: Session, steamUser: unknown): void {
  if (isObjectLike(steamUser) && 'onlineState' in steamUser) {
    session.getState().setEnabled((steamUser as { onlineState: string }).onlineState === 'offline');
  }
}
