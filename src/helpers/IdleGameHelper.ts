import { humanizeDuration } from '@vegapunk/utilities/time';
import { Effect, Random } from 'effect';
import SteamUser from 'steam-user';

import { SessionStore } from '../core/schemas.js';
import { SteamClientTag } from '../services/SteamService.js';

const MAX_IDLE_GAMES = 32;

export const startIdleGames = (username: string): Effect.Effect<number, never, SteamClientTag | SessionStore> =>
  Effect.gen(function* () {
    const steamClient = yield* SteamClientTag;
    const sessionStore = yield* SessionStore;
    const sessionData = yield* sessionStore.get;

    const idleMinutes = yield* Random.nextIntBetween(60, 180);
    const idleMs = idleMinutes * 60_000;
    const now = yield* Effect.clock.pipe(Effect.flatMap((clock) => clock.currentTimeMillis));
    const nextIdleAt = now + idleMs;

    const allOwnedIds = sessionData.ownedGameList;
    const totalOwned = allOwnedIds.length;

    if (totalOwned === 0) {
      return nextIdleAt;
    }

    const maxIdleTotal = Math.min(MAX_IDLE_GAMES, totalOwned);
    let idsToIdle: number[];

    const indices = Array.from({ length: totalOwned }, (_, i) => i);

    for (let i = 0; i < maxIdleTotal; i++) {
      const j = yield* Random.nextIntBetween(i, totalOwned - 1);
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }

    const selectedIndices = indices.slice(0, maxIdleTotal);
    idsToIdle = selectedIndices.map((idx) => allOwnedIds[idx].appId);

    yield* steamClient.updatePersonaAndGames(SteamUser.EPersonaState.Online, idsToIdle);

    const durationString = humanizeDuration(idleMs, { units: ['h', 'm'], round: true });
    yield* Effect.logInfo(`${username} idling ${idsToIdle.length} games for ${durationString}`);
    yield* Effect.logInfo(`- ${idsToIdle.join(', ').trim()}`);

    return nextIdleAt;
  });
