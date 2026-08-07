import { join } from 'node:path';
import { chalk } from '@vegapunk/utilities';
import { Cause, Deferred, Effect, Layer, Ref, Schedule, Stream } from 'effect';
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

  return checkLoggedOn(
    Effect.gen(function* () {
      yield* collectOwnGames(user);
      yield* collectFreeGames(user);
      yield* Effect.sleep('1 minute');
    }),
  ).pipe(Effect.repeat(Schedule.forever));
};

const COMMUNITY_CHECK_COOLDOWN_MS = 120_000;

const cycleIdler = (user: UserContext, steamClient: SteamClient, state: UserWorkflowState) =>
  Effect.gen(function* () {
    const checkLoggedOn = whenLoggedOn(state);
    const nextIdleTimeRef = yield* Ref.make(0);
    const lastCommunityCheckRef = yield* Ref.make(0);

    return yield* checkLoggedOn(
      Effect.gen(function* () {
        const { isPlaying, family, isEnabled } = yield* Ref.get(state.state);

        const hasFamilyOnline = Object.values(family).some((status) => !(USER_OFFLINE_STATE as readonly number[]).includes(status));

        if (hasFamilyOnline) {
          yield* Ref.set(nextIdleTimeRef, 0);
          if (isPlaying) {
            yield* state.setGamesPlayed([]);
          }
          return;
        }

        const now = yield* Effect.clock.pipe(Effect.flatMap((clock) => clock.currentTimeMillis));

        if (!isEnabled && !isPlaying) {
          const lastCommunityCheck = yield* Ref.get(lastCommunityCheckRef);

          if (now - lastCommunityCheck >= COMMUNITY_CHECK_COOLDOWN_MS) {
            yield* Ref.set(lastCommunityCheckRef, now);

            const steamId = yield* steamClient.steamID;
            const communityUser = steamId ? yield* steamClient.getCommunityUser(steamId) : null;
            const hasValidOnlineState = communityUser && typeof communityUser.onlineState === 'string';

            if (hasValidOnlineState) {
              yield* Ref.update(state.state, (s) => ({
                ...s,
                isEnabled: communityUser.onlineState === 'offline',
              }));
            }
          }
        }

        const currentState = yield* Ref.get(state.state);

        if (!currentState.isEnabled) {
          yield* Ref.set(nextIdleTimeRef, 0);

          if (isPlaying) {
            yield* state.setGamesPlayed([]);
          }

          return;
        }

        const nextIdleTime = yield* Ref.get(nextIdleTimeRef);
        const isTimeReached = now > nextIdleTime;

        if (isTimeReached) {
          const nextTime = yield* startIdleGames(user.username);
          yield* Ref.set(nextIdleTimeRef, nextTime);
          yield* Ref.update(state.state, (s) => ({ ...s, isPlaying: true }));
        }
      }),
    ).pipe(Effect.repeat(Schedule.spaced('30 seconds')));
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
      return yield* new AuthError({ message: `No credentials found for ${user.username}` });
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
      family: Object.fromEntries((user.family ?? []).map((r) => [r, -1])),
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

    // We use a manual pull loop instead of Stream.runForEach to bypass internal stream supervision.
    // This fix "Fiber terminated with an unhandled error" problem until found better way to suppress.
    const handleEvents = Effect.scoped(
      steamClient.events.pipe(
        Stream.toPull,
        Effect.flatMap((pull) =>
          pull.pipe(
            Effect.flatMap((chunk) => Effect.forEach(chunk, (event) => handleSteamEvent(event, user, steamClient, state))),
            Effect.repeat(Schedule.forever),
          ),
        ),
      ),
    );

    const watchdog = Effect.gen(function* () {
      yield* Deferred.await(state.loggedOn);
      yield* Effect.sleep('1 minute');
      const s = yield* Ref.get(state.state);
      const hasFamilyOnline = Object.values(s.family).some((status) => !(USER_OFFLINE_STATE as readonly number[]).includes(status));
      const isNotPlayingWhileEnabled = s.isEnabled && !s.isPlaying && !hasFamilyOnline;

      if (isNotPlayingWhileEnabled) {
        yield* Effect.logInfo(chalk`${user.username} not playing games after 1 minute of login`);
        return yield* new Cause.TimeoutException();
      }
    });

    yield* Effect.all(
      [
        handleEvents,
        cycleCollector(user, state),
        cycleIdler(user, steamClient, state),
        tryLogin(user, steamClient).pipe(Effect.andThen(Effect.never)),
        watchdog,
      ],
      { concurrency: 'unbounded' },
    );
  });

export const runUserWorkflow = (user: UserContext) =>
  Effect.gen(function* () {
    const sessionDir = join(process.cwd(), 'sessions', user.username);
    const sessionPath = join(sessionDir, 'session.json');

    const configStore = yield* ConfigStoreTag;
    const currentUser = yield* configStore.get.pipe(Effect.map((cfg) => cfg.users.find((u) => u.username === user.username) ?? user));

    yield* createUserSession(currentUser).pipe(
      Effect.provide(
        Layer.mergeAll(SteamClientLayer(sessionDir), StoreClientLayer(SessionStore, sessionPath, SessionContext, INITIAL_SESSION, 600_000)),
      ),
      Effect.retry(
        Schedule.spaced('10 seconds').pipe(
          Schedule.tapInput((error) =>
            Effect.gen(function* () {
              const isAuthError = error instanceof AuthError;
              if (isAuthError) {
                yield* Effect.logError(chalk`{bold.red ${user.username} authentication failed: ${error.message}. Stopping workflow.}`);
              } else {
                yield* Effect.logInfo(chalk`{yellow Retrying workflow for ${user.username}...}`);
              }
            }),
          ),
          Schedule.whileInput((error) => !(error instanceof AuthError)),
        ),
      ),
    );
  });
