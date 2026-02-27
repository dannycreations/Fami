import { shuffle } from '@vegapunk/utilities/common';
import { humanizeDuration } from '@vegapunk/utilities/time';
import { Effect, Random } from 'effect';
import SteamUser from 'steam-user';

import { SessionStore } from '../core/schemas';
import { SteamClientTag } from '../services/SteamService';

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

    const allOwnedIds = sessionData.ownedGameList.map((game) => game.appId);
    const maxIdleTotal = Math.min(MAX_IDLE_GAMES, allOwnedIds.length);

    if (maxIdleTotal === 0) {
      return nextIdleAt;
    }

    shuffle(allOwnedIds);
    const idsToIdle = allOwnedIds.slice(0, maxIdleTotal);

    yield* steamClient.setPersona(SteamUser.EPersonaState.Online);
    yield* steamClient.gamesPlayed(idsToIdle);

    const durationString = humanizeDuration(idleMs, { units: ['h', 'm'], round: true });
    yield* Effect.logInfo(`${username} idling ${idsToIdle.length} games for ${durationString}`);
    yield* Effect.logInfo(`- ${idsToIdle.join(', ').trim()}`);

    return nextIdleAt;
  });
