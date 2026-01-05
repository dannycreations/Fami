import { join } from 'node:path';
import { waitForConnection } from '@vegapunk/request';
import { Effect, Ref, Schedule, Stream } from 'effect';
import SteamUser from 'steam-user';

import { ConfigContext, INITIAL_SESSION_DATA, SessionData, UserContext } from '../core/schemas';
import { collectFreeGames } from '../services/FreeGameService';
import { startIdleGames } from '../services/IdleService';
import { collectOwnGames } from '../services/OwnGameService';
import { SteamClient, SteamClientLive } from '../services/SteamService';
import { makeStore, Store } from '../services/StoreService';
import { handleSteamEvent, UserWorkflowState } from './UserEvents';

const makeUserSession = (user: UserContext, configStore: Store<ConfigContext>, registrationSemaphore: Effect.Semaphore) =>
  Effect.gen(function* (_) {
    const steamClient = yield* _(SteamClient);
    const sessionDir = join(process.cwd(), 'sessions', user.username);
    const sessionStore = yield* _(
      makeStore(join(sessionDir, 'session.json'), SessionData, INITIAL_SESSION_DATA, 600_000),
      Effect.tap((store) => Effect.addFinalizer(() => store.dispose)),
    );

    const isPlaying = yield* _(Ref.make(false));

    const state: UserWorkflowState = {
      isLoggedOn: yield* _(Ref.make(false)),
      isEnabled: yield* _(Ref.make(false)),
      isPlaying,
      familyState: yield* _(Ref.make(Object.fromEntries((user.family ?? []).map((r: string) => [r, -1])))),
      setGamesPlayed: (appIds: number[]) =>
        Effect.gen(function* (_) {
          const hasIds = appIds.length > 0;
          const currentPlaying = yield* _(Ref.get(isPlaying));

          if (!hasIds && !currentPlaying) return;

          yield* _(steamClient.setPersona(hasIds ? SteamUser.EPersonaState.Online : SteamUser.EPersonaState.Invisible));
          yield* _(steamClient.gamesPlayed(appIds));
          yield* _(Ref.set(isPlaying, hasIds));
        }),
      reset: () =>
        Effect.gen(function* (_) {
          yield* _(Ref.set(state.isLoggedOn, false));
          yield* _(Ref.set(state.isEnabled, false));
          yield* _(state.setGamesPlayed([]));
        }),
    };

    const handleEvents = steamClient.events.pipe(
      Stream.runForEach((event) => handleSteamEvent(event, user, steamClient, configStore, sessionStore, state)),
    );

    const login = Effect.gen(function* (_) {
      yield* _(Effect.tryPromise(() => waitForConnection()));

      const loginDetails = user.refreshToken ? { refreshToken: user.refreshToken } : { accountName: user.username, password: user.password };

      yield* _(Effect.logInfo(`${user.username} logging in with ${user.refreshToken ? 'refresh token' : 'password'}`));

      yield* _(
        steamClient.logOn(loginDetails),
        Effect.timeout('1 minute'),
        Effect.catchTag('TimeoutException', () =>
          Effect.gen(function* (_) {
            yield* _(Effect.logError(`${user.username} login timed out`));
            return yield* _(Effect.fail(new Error('Login timed out')));
          }),
        ),
      );
    });

    const whenLoggedOn = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* (_) {
        const logged = yield* _(Ref.get(state.isLoggedOn));
        if (logged) {
          yield* _(effect);
        } else {
          yield* _(Effect.sleep('10 seconds'));
        }
      });

    const freeGameLoop = whenLoggedOn(
      Effect.gen(function* (_) {
        const config = yield* _(configStore.get);
        if (config.fetchFreeGames || user.fetchFreeGames) {
          yield* _(collectFreeGames(sessionStore, user, config.blacklistGameIds, registrationSemaphore, config.refreshGames));
        }
      }),
    ).pipe(Effect.repeat(Schedule.spaced('1 minute')));

    const ownGameLoop = whenLoggedOn(
      Effect.gen(function* (_) {
        const config = yield* _(configStore.get);
        yield* _(collectOwnGames(sessionStore, user, config.whitelistGameIds, config.blacklistGameIds));
        yield* _(Effect.sleep(`${config.refreshGames} millis`));
      }),
    ).pipe(Effect.repeat(Schedule.spaced('1 minute')));

    const presenceLoop = whenLoggedOn(
      Effect.gen(function* (_) {
        const family = yield* _(Ref.get(state.familyState));
        const hasFamilyOnline = Object.values(family).some((s) => (typeof s === 'number' ? s > 0 : false));
        const playing = yield* _(Ref.get(isPlaying));

        if (hasFamilyOnline) {
          yield* _(Ref.set(state.isEnabled, false));
        } else if (!playing) {
          const sid = yield* _(steamClient.steamID);
          if (sid) {
            const communityUser = yield* _(steamClient.getCommunityUser(sid));
            if (communityUser && typeof communityUser.onlineState === 'string') {
              const shouldEnable = communityUser.onlineState === 'offline';
              yield* _(Ref.set(state.isEnabled, shouldEnable));
            }
          }
        }
      }),
    ).pipe(Effect.repeat(Schedule.spaced('1 minute')));

    const nextIdleTimeRef = yield* _(Ref.make(0));
    const idleLoop = whenLoggedOn(
      Effect.gen(function* (_) {
        const enabled = yield* _(Ref.get(state.isEnabled));
        const playing = yield* _(Ref.get(isPlaying));
        const now = Date.now();
        const nextIdleTime = yield* _(Ref.get(nextIdleTimeRef));

        if (enabled) {
          if (now > nextIdleTime) {
            const nextTime = yield* _(startIdleGames(sessionStore, user.username));
            yield* _(Ref.set(nextIdleTimeRef, nextTime));
            yield* _(Ref.set(isPlaying, true));
          }
        } else {
          yield* _(Ref.set(nextIdleTimeRef, 0));
          if (playing) {
            yield* _(state.setGamesPlayed([]));
            yield* _(Ref.set(isPlaying, false));
          }
        }
      }),
    ).pipe(Effect.repeat(Schedule.spaced('10 seconds')));

    yield* _(Effect.all([handleEvents, freeGameLoop, ownGameLoop, presenceLoop, idleLoop], { concurrency: 'unbounded' }), Effect.fork);
    yield* _(login);
    yield* _(Effect.never);
  });

export const runUserWorkflow = (user: UserContext, configStore: Store<ConfigContext>, registrationSemaphore: Effect.Semaphore) =>
  Effect.scoped(
    Effect.gen(function* (_) {
      const sessionDir = join(process.cwd(), 'sessions', user.username);
      yield* _(
        makeUserSession(user, configStore, registrationSemaphore),
        Effect.provide(SteamClientLive(sessionDir)),
        Effect.retry(
          Schedule.exponential('5 seconds').pipe(
            Schedule.union(Schedule.spaced('1 minute')),
            Schedule.tapInput(() => Effect.logInfo(`Retrying workflow for ${user.username}...`)),
          ),
        ),
      );
    }),
  );
