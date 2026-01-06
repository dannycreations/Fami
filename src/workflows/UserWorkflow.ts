import { join } from 'node:path';
import { chalk } from '@vegapunk/utilities';
import { Effect, Ref, Schedule, Stream } from 'effect';
import SteamUser from 'steam-user';

import { ConfigContext, INITIAL_SESSION_DATA, SessionData, UserContext } from '../core/schemas';
import { collectFreeGames } from '../services/FreeGameService';
import { startIdleGames } from '../services/IdleService';
import { collectOwnGames } from '../services/OwnGameService';
import { SteamClient, SteamClientLive } from '../services/SteamService';
import { makeStore, Store } from '../services/StoreService';
import { handleSteamEvent, UserWorkflowState } from './UserEvents';

const whenLoggedOn = (state: UserWorkflowState) => {
  const wait = Ref.get(state.isLoggedOn).pipe(Effect.repeat(Schedule.spaced('1 second').pipe(Schedule.whileInput((logged) => !logged))));
  return <A, E, R>(effect: Effect.Effect<A, E, R>) => wait.pipe(Effect.zipRight(effect));
};

const runLogin = (user: UserContext, steamClient: SteamClient) =>
  Effect.gen(function* (_) {
    const loginDetails = user.refreshToken
      ? ({ refreshToken: user.refreshToken } satisfies SteamUser.LogOnDetailsRefresh)
      : ({ accountName: user.username, password: user.password } satisfies SteamUser.LogOnDetailsNamePass);

    yield* _(Effect.logInfo(`${user.username} logging in with ${user.refreshToken ? 'refresh token' : 'password'}`));

    yield* _(
      steamClient.logOn(loginDetails),
      Effect.timeout('1 minute'),
      Effect.catchTag('TimeoutException', () => Effect.fail(new Error('Login timed out'))),
    );
  });

const runGameLoops = (
  user: UserContext,
  configStore: Store<ConfigContext>,
  sessionStore: Store<SessionData>,
  registrationSemaphore: Effect.Semaphore,
  state: UserWorkflowState,
) => {
  const checkLoggedOn = whenLoggedOn(state);

  const gameLoop = checkLoggedOn(
    Effect.gen(function* (_) {
      const config = yield* _(configStore.get);

      // Collect own games first to ensure filters are up to date
      yield* _(collectOwnGames(sessionStore, user, config.whitelistGameIds, config.blacklistGameIds));

      // Then check for free games if enabled
      if (config.fetchFreeGames || user.fetchFreeGames) {
        yield* _(collectFreeGames(sessionStore, user, config.blacklistGameIds, registrationSemaphore, config.refreshGames));
      }

      yield* _(Effect.sleep(`${config.refreshGames} millis`));
    }),
  ).pipe(Effect.repeat(Schedule.forever));

  return gameLoop;
};

const runPresenceAndIdle = (user: UserContext, steamClient: SteamClient, sessionStore: Store<SessionData>, state: UserWorkflowState) =>
  Effect.gen(function* (_) {
    const checkLoggedOn = whenLoggedOn(state);
    const nextIdleTimeRef = yield* _(Ref.make(0));

    const idleLoop = checkLoggedOn(
      Effect.gen(function* (_) {
        const playing = yield* _(Ref.get(state.isPlaying));
        const family = yield* _(Ref.get(state.familyState));
        const hasFamilyOnline = Object.values(family).some((s) => s > 0);

        if (hasFamilyOnline) {
          yield* _(Ref.set(state.isEnabled, false));
        } else if (!hasFamilyOnline && !playing) {
          // If no family online and not already playing, check community status (self presence)
          const steamId = yield* _(steamClient.steamID);
          const communityUser = yield* _(steamClient.getCommunityUser(steamId!));
          if (communityUser && typeof communityUser.onlineState === 'string') {
            yield* _(Ref.set(state.isEnabled, communityUser.onlineState === 'offline'));
          }
        }

        if (yield* _(Ref.get(state.isEnabled))) {
          if (Date.now() > (yield* _(Ref.get(nextIdleTimeRef)))) {
            const nextTime = yield* _(startIdleGames(sessionStore, user.username));
            yield* _(Ref.set(nextIdleTimeRef, nextTime));
            yield* _(Ref.set(state.isPlaying, true));
          }
        } else {
          yield* _(Ref.set(nextIdleTimeRef, 0));
          if (playing) {
            yield* _(state.setGamesPlayed([]));
            yield* _(Ref.set(state.isPlaying, false));
          }
        }
      }),
    ).pipe(Effect.repeat(Schedule.spaced('30 seconds')));

    return yield* _(idleLoop);
  });

const makeUserSession = (user: UserContext, configStore: Store<ConfigContext>, registrationSemaphore: Effect.Semaphore) =>
  Effect.gen(function* (_) {
    const steamClient = yield* _(SteamClient);
    const sessionDir = join(process.cwd(), 'sessions', user.username);
    const sessionStore = yield* _(makeStore(join(sessionDir, 'session.json'), SessionData, INITIAL_SESSION_DATA, 600_000));

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

    yield* _(
      Effect.all(
        [
          handleEvents,
          runGameLoops(user, configStore, sessionStore, registrationSemaphore, state),
          runPresenceAndIdle(user, steamClient, sessionStore, state),
          runLogin(user, steamClient).pipe(Effect.andThen(Effect.never)),
        ],
        { concurrency: 'unbounded' },
      ),
    );
  });

export const runUserWorkflow = (user: UserContext, configStore: Store<ConfigContext>, registrationSemaphore: Effect.Semaphore) =>
  Effect.gen(function* (_) {
    const sessionDir = join(process.cwd(), 'sessions', user.username);
    yield* _(
      makeUserSession(user, configStore, registrationSemaphore).pipe(
        Effect.provide(SteamClientLive(sessionDir)),
        Effect.scoped,
        Effect.retry(
          Schedule.spaced('10 seconds').pipe(Schedule.tapInput(() => Effect.logInfo(chalk`{yellow Retrying workflow for ${user.username}...}`))),
        ),
      ),
    );
  });
