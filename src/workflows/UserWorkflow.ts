import { join } from 'node:path';
import { chalk } from '@vegapunk/utilities';
import { Array, Deferred, Effect, Ref, Schedule, Stream } from 'effect';
import SteamUser from 'steam-user';

import { AuthError } from '../core/errors';
import { ConfigStoreTag, INITIAL_SESSION, SessionContext, SessionStore, UserContext } from '../core/schemas';
import { collectFreeGames } from '../helpers/FreeGameHelper';
import { startIdleGames } from '../helpers/IdleGameHelper';
import { collectOwnGames } from '../helpers/OwnGameHelper';
import { SteamClient, SteamClientLayer, SteamClientTag } from '../services/SteamService';
import { waitForConnection } from '../structures/HttpClient';
import { StoreClientLayer } from '../structures/StoreClient';
import { handleSteamEvent, USER_OFFLINE_STATE, UserWorkflowState } from './UserEvents';

const whenLoggedOn =
  (state: UserWorkflowState) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Deferred.await(state.loggedOn).pipe(Effect.zipRight(effect));

const cycleCollector = (user: UserContext, state: UserWorkflowState) => {
  const checkLoggedOn = whenLoggedOn(state);

  const ownGamesLoop = checkLoggedOn(
    Effect.gen(function* () {
      const configStore = yield* ConfigStoreTag;
      const config = yield* configStore.get;

      yield* collectOwnGames(user);
      yield* Effect.sleep(`${config.refreshGames} millis`);
    }),
  ).pipe(Effect.repeat(Schedule.forever));

  const freeGamesLoop = checkLoggedOn(
    Effect.gen(function* () {
      yield* collectFreeGames(user);
      yield* Effect.sleep('1 minute');
    }),
  ).pipe(Effect.repeat(Schedule.forever));

  return Effect.all([ownGamesLoop, freeGamesLoop], { concurrency: 'unbounded' });
};

const cycleIdler = (user: UserContext, steamClient: SteamClient, state: UserWorkflowState) =>
  Effect.gen(function* () {
    const checkLoggedOn = whenLoggedOn(state);
    const nextIdleTimeRef = yield* Ref.make(0);

    const idleLoop = checkLoggedOn(
      Effect.gen(function* () {
        const { isPlaying, family } = yield* Ref.get(state.state);
        const hasFamilyOnline = Object.values(family).some((s) => !Array.contains(USER_OFFLINE_STATE, s));

        if (hasFamilyOnline) {
          yield* Ref.update(state.state, (s) => ({ ...s, isEnabled: false }));
        } else if (!hasFamilyOnline && !isPlaying) {
          const steamId = yield* steamClient.steamID;
          if (steamId) {
            const communityUser = yield* steamClient.getCommunityUser(steamId);
            if (communityUser && typeof communityUser.onlineState === 'string') {
              yield* Ref.update(state.state, (s) => ({
                ...s,
                isEnabled: communityUser.onlineState === 'offline',
              }));
            }
          }
        }

        const currentState = yield* Ref.get(state.state);
        const now = yield* Effect.clock.pipe(Effect.flatMap((clock) => clock.currentTimeMillis));
        if (currentState.isEnabled) {
          if (now > (yield* Ref.get(nextIdleTimeRef))) {
            const nextTime = yield* startIdleGames(user.username);
            yield* Ref.set(nextIdleTimeRef, nextTime);
            yield* Ref.update(state.state, (s) => ({ ...s, isPlaying: true }));
          }
        } else {
          yield* Ref.set(nextIdleTimeRef, 0);
          if (isPlaying) {
            yield* state.setGamesPlayed([]);
            yield* Ref.update(state.state, (s) => ({ ...s, isPlaying: false }));
          }
        }
      }),
    ).pipe(Effect.repeat(Schedule.spaced('30 seconds')));

    return yield* idleLoop;
  });

const tryLogin = (user: UserContext, steamClient: SteamClient) =>
  Effect.gen(function* () {
    const loginDetails = user.refreshToken
      ? ({ refreshToken: user.refreshToken } satisfies SteamUser.LogOnDetailsRefresh)
      : user.password
        ? ({
            accountName: user.username,
            password: user.password,
          } satisfies SteamUser.LogOnDetailsNamePass)
        : null;

    if (!loginDetails) {
      return yield* Effect.fail(new AuthError({ message: `No credentials found for ${user.username}` }));
    }

    yield* waitForConnection();
    yield* Effect.logInfo(`${user.username} logging in with ${user.refreshToken ? 'refresh token' : 'password'}`);
    yield* steamClient.logOn(loginDetails);
  });

const createUserSession = (user: UserContext) =>
  Effect.gen(function* () {
    const steamClient = yield* SteamClientTag;

    const stateRef = yield* Ref.make({
      isEnabled: false,
      isPlaying: false,
      family: Object.fromEntries(Array.map(user.family ?? [], (r) => [r, -1])),
    });

    const state: UserWorkflowState = {
      loggedOn: yield* Deferred.make<void>(),
      state: stateRef,
      setGamesPlayed: (appIds: number[]) =>
        Effect.gen(function* () {
          const hasIds = appIds.length > 0;
          const { isPlaying } = yield* Ref.get(stateRef);

          if (!hasIds && !isPlaying) {
            return;
          }

          yield* steamClient.updatePersonaAndGames(hasIds ? SteamUser.EPersonaState.Online : SteamUser.EPersonaState.Invisible, appIds);
          yield* Ref.update(stateRef, (s) => ({ ...s, isPlaying: hasIds }));
        }),
      reset: () =>
        Effect.gen(function* () {
          yield* Ref.update(stateRef, (s) => ({ ...s, isEnabled: false }));
          yield* state.setGamesPlayed([]);
        }),
    };

    const handleEvents = steamClient.events.pipe(Stream.runForEach((event) => handleSteamEvent(event, user, steamClient, state)));

    yield* Effect.all(
      [
        handleEvents,
        cycleCollector(user, state),
        cycleIdler(user, steamClient, state),
        tryLogin(user, steamClient).pipe(Effect.andThen(Effect.never)),
      ],
      { concurrency: 'unbounded' },
    );
  });

export const runUserWorkflow = (user: UserContext) =>
  Effect.gen(function* () {
    const sessionDir = join(process.cwd(), 'sessions', user.username);
    const sessionPath = join(sessionDir, 'session.json');

    yield* createUserSession(user).pipe(
      Effect.provide(SteamClientLayer(sessionDir)),
      Effect.provide(StoreClientLayer(SessionStore, sessionPath, SessionContext, INITIAL_SESSION, 600_000)),
      Effect.retry(
        Schedule.spaced('10 seconds').pipe(Schedule.tapInput(() => Effect.logInfo(chalk`{yellow Retrying workflow for ${user.username}...}`))),
      ),
    );
  });
