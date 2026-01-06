import { shuffle } from '@vegapunk/utilities/common';
import { humanizeDuration } from '@vegapunk/utilities/time';
import { Effect, Random } from 'effect';
import SteamUser from 'steam-user';

import { SessionContext } from '../core/schemas';
import { SteamClient } from './SteamService';
import { Store } from './StoreService';

const MAX_IDLE_GAMES = 32;

export const startIdleGames = (store: Store<SessionContext>, username: string) =>
  Effect.gen(function* (_) {
    const steamClient = yield* _(SteamClient);
    const sessionData = yield* _(store.get);

    const idleMs = (yield* _(Random.nextIntBetween(60, 180))) * 60_000;
    const nextIdleAt = Date.now() + idleMs;

    const allOwnedIds = sessionData.ownedGameList.map((game) => game.appId);
    const maxIdleTotal = Math.min(MAX_IDLE_GAMES, allOwnedIds.length);

    if (maxIdleTotal === 0) {
      return nextIdleAt;
    }

    const shuffledIds = shuffle(allOwnedIds);
    const idsToIdle = shuffledIds.slice(0, maxIdleTotal);

    yield* _(steamClient.setPersona(SteamUser.EPersonaState.Online));
    yield* _(steamClient.gamesPlayed(idsToIdle));

    const durationString = humanizeDuration(idleMs, { units: ['h', 'm'], round: true });
    yield* _(Effect.logInfo(`${username} idling ${idsToIdle.length} games for ${durationString}`));
    yield* _(Effect.logInfo(`- ${idsToIdle.join(', ').trim()}`));

    return nextIdleAt;
  });
