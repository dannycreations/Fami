import { join } from 'node:path';
import { chalk } from '@vegapunk/utilities';
import { Deferred, Effect, Ref, Schedule, Stream } from 'effect';
import SteamUser from 'steam-user';

import { AuthError } from '../core/errors';
import { ConfigStoreTag, INITIAL_SESSION, SessionContext, SessionStore, UserContext } from '../core/schemas';
import { collectFreeGames } from '../helpers/FreeGameHelper';
import { startIdleGames } from '../helpers/IdleGameHelper';
import { collectOwnGames } from '../helpers/OwnGameHelper';
import { SteamClientLayer, SteamClientTag } from '../services/SteamService';
import { waitForConnection } from '../structures/HttpClient';
import { StoreClientLayer } from '../structures/StoreClient';
import { handleSteamEvent, USER_OFFLINE_STATE, UserWorkflowState } from './UserEvents';

const whenLoggedOn = (state: UserWorkflowState) => {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) => Deferred.await(state.loggedOn).pipe(Effect.zipRight(effect));
};

const cycleCollector = (user: UserContext, state: UserWorkflowState) => {
  const checkLoggedOn = whenLoggedOn(state);

  const ownGamesLoop = checkLoggedOn(
    Effect.gen(function* (_) {
      const configStore = yield* _(ConfigStoreTag);
      const config = yield* _(configStore.get);
      yield* _(collectOwnGames(user));
      yield* _(Effect.sleep(`${config.refreshGames} millis`));
    }),
  ).pipe(Effect.repeat(Schedule.forever));

  const freeGamesLoop = checkLoggedOn(
    Effect.gen(function* (_) {
      yield* _(collectFreeGames(user));
      yield* _(Effect.sleep('1 minute'));
    }),
  ).pipe(Effect.repeat(Schedule.forever));

  return Effect.all([ownGamesLoop, freeGamesLoop], { concurrency: 'unbounded' });
};

const cycleIdler = (user: UserContext, steamClient: SteamClientTag, state: UserWorkflowState) =>
  Effect.gen(function* (_) {
    const checkLoggedOn = whenLoggedOn(state);
    const nextIdleTimeRef = yield* _(Ref.make(0));

    const idleLoop = checkLoggedOn(
      Effect.gen(function* (_) {
        const { isPlaying, family } = yield* _(Ref.get(state.state));
        // Treat -1 (unknown) as online to prevent race conditions during startup
        const hasFamilyOnline = Object.values(family).some((s) => !USER_OFFLINE_STATE.includes(s));

        if (hasFamilyOnline) {
          yield* _(Ref.update(state.state, (s) => ({ ...s, isEnabled: false })));
        } else if (!hasFamilyOnline && !isPlaying) {
          const steamId = yield* _(steamClient.steamID);
          if (steamId) {
            const communityUser = yield* _(steamClient.getCommunityUser(steamId));
            if (communityUser && typeof communityUser.onlineState === 'string') {
              yield* _(Ref.update(state.state, (s) => ({ ...s, isEnabled: communityUser.onlineState === 'offline' })));
            }
          }
        }

        const currentState = yield* _(Ref.get(state.state));
        if (currentState.isEnabled) {
          if (Date.now() > (yield* _(Ref.get(nextIdleTimeRef)))) {
            const nextTime = yield* _(startIdleGames(user.username));
            yield* _(Ref.set(nextIdleTimeRef, nextTime));
            yield* _(Ref.update(state.state, (s) => ({ ...s, isPlaying: true })));
          }
        } else {
          yield* _(Ref.set(nextIdleTimeRef, 0));
          if (isPlaying) {
            yield* _(state.setGamesPlayed([]));
            yield* _(Ref.update(state.state, (s) => ({ ...s, isPlaying: false })));
          }
        }
      }),
    ).pipe(Effect.repeat(Schedule.spaced('30 seconds')));

    return yield* _(idleLoop);
  });

const tryLogin = (user: UserContext, steamClient: SteamClientTag) =>
  Effect.gen(function* (_) {
    const loginDetails = user.refreshToken
      ? ({ refreshToken: user.refreshToken } satisfies SteamUser.LogOnDetailsRefresh)
      : user.password
        ? ({ accountName: user.username, password: user.password } satisfies SteamUser.LogOnDetailsNamePass)
        : null;

    if (!loginDetails) {
      return yield* _(Effect.fail(new AuthError({ message: `No credentials found for ${user.username}` })));
    }

    yield* _(waitForConnection());
    yield* _(Effect.logInfo(`${user.username} logging in with ${user.refreshToken ? 'refresh token' : 'password'}`));
    yield* _(steamClient.logOn(loginDetails));
  });

const createUserSession = (user: UserContext) =>
  Effect.gen(function* (_) {
    const steamClient = yield* _(SteamClientTag);

    const stateRef = yield* _(
      Ref.make({
        isEnabled: false,
        isPlaying: false,
        family: Object.fromEntries((user.family ?? []).map((r: string) => [r, -1])),
      }),
    );

    const state: UserWorkflowState = {
      loggedOn: yield* _(Deferred.make<void>()),
      state: stateRef,
      setGamesPlayed: (appIds: number[]) =>
        Effect.gen(function* (_) {
          const hasIds = appIds.length > 0;
          const { isPlaying } = yield* _(Ref.get(stateRef));

          if (!hasIds && !isPlaying) return;

          yield* _(steamClient.updatePersonaAndGames(hasIds ? SteamUser.EPersonaState.Online : SteamUser.EPersonaState.Invisible, appIds));
          yield* _(Ref.update(stateRef, (s) => ({ ...s, isPlaying: hasIds })));
        }),
      reset: () =>
        Effect.gen(function* (_) {
          yield* _(Ref.update(stateRef, (s) => ({ ...s, isEnabled: false })));
          yield* _(state.setGamesPlayed([]));
        }),
    };

    const handleEvents = steamClient.events.pipe(Stream.runForEach((event) => handleSteamEvent(event, user, steamClient, state)));

    yield* _(
      Effect.all(
        [
          handleEvents,
          cycleCollector(user, state),
          cycleIdler(user, steamClient, state),
          tryLogin(user, steamClient).pipe(Effect.andThen(Effect.never)),
        ],
        { concurrency: 'unbounded' },
      ),
    );
  });

export const runUserWorkflow = (user: UserContext) =>
  Effect.gen(function* (_) {
    const sessionDir = join(process.cwd(), 'sessions', user.username);
    const sessionPath = join(sessionDir, 'session.json');

    yield* _(
      createUserSession(user).pipe(
        Effect.provide(SteamClientLayer(sessionDir)),
        Effect.provide(StoreClientLayer(SessionStore, sessionPath, SessionContext, INITIAL_SESSION, 600_000)),
        Effect.scoped,
        Effect.retry(
          Schedule.spaced('10 seconds').pipe(Schedule.tapInput(() => Effect.logInfo(chalk`{yellow Retrying workflow for ${user.username}...}`))),
        ),
      ),
    );
  });
