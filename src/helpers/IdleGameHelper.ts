import { humanizeDuration } from '@vegapunk/utilities/time';
import { Effect, Random } from 'effect';
import SteamUser from 'steam-user';

import { SessionStore } from '../core/schemas.js';
import { nowMillis } from '../core/utils.js';
import { SteamClientTag } from '../services/SteamService.js';

const MAX_IDLE_GAMES = 32;

export const startIdleGames = (username: string): Effect.Effect<number, never, SteamClientTag | SessionStore> =>
  Effect.gen(function* () {
    const steamClient = yield* SteamClientTag;
    const sessionStore = yield* SessionStore;
    const sessionData = yield* sessionStore.get;

    const idleMinutes = yield* Random.nextIntBetween(60, 180);
    const idleMs = idleMinutes * 60_000;
    const now = yield* nowMillis;
    const nextIdleAt = now + idleMs;

    const ownedGames = sessionData.ownedGameList;
    const totalOwned = ownedGames.length;

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
    idsToIdle = selectedIndices.map((idx) => ownedGames[idx].appId);

    yield* steamClient.updatePersonaAndGames(SteamUser.EPersonaState.Online, idsToIdle);

    const durationString = humanizeDuration(idleMs, { units: ['h', 'm'], round: true });
    yield* Effect.logInfo(`${username} idling ${idsToIdle.length} games for ${durationString}`);
    yield* Effect.logInfo(`- ${idsToIdle.join(', ')}`);

    return nextIdleAt;
  });
