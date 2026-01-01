import { container } from '@vegapunk/core';
import { random, shuffle } from '@vegapunk/utilities/common';
import { humanizeDuration } from '@vegapunk/utilities/time';

import type { Session } from '../struct/Session';

export function startIdleGames(session: Session): number {
  const maxIdleCount = Math.min(32, session.ownedGameList.length);

  const idleMs = random(60, 120) * 60_000;
  const nextIdleAt = Date.now() + idleMs;

  const allOwnedIds = session.ownedGameList.map((game) => game.appid);
  const idsToIdle = shuffle(allOwnedIds).slice(0, maxIdleCount);

  session.gamesPlayed(idsToIdle);

  const durationString = humanizeDuration(idleMs, { units: ['h', 'm'], round: true });
  container.logger.info(`${session.username} idling ${idsToIdle.length} games for ${durationString}.`);
  container.logger.info(`• ${idsToIdle.join(', ')}.`);

  return nextIdleAt;
}
