import { join } from 'node:path';
import { chalk } from '@vegapunk/utilities';
import { Deferred, Effect, Ref, Schedule, Stream } from 'effect';
import SteamUser from 'steam-user';

import { AuthError } from '../core/errors';
import { ConfigContext, INITIAL_SESSION, SessionContext, UserContext } from '../core/schemas';
import { collectFreeGames } from '../services/FreeGameService';
import { startIdleGames } from '../services/IdleService';
import { collectOwnGames } from '../services/OwnGameService';
import { SteamClient, SteamClientLive } from '../services/SteamService';
import { makeStore, Store } from '../services/StoreService';
import { handleSteamEvent, UserWorkflowState } from './UserEvents';

const whenLoggedOn = (state: UserWorkflowState) => {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) => Deferred.await(state.loggedOn).pipe(Effect.zipRight(effect));
};

const runLogin = (user: UserContext, steamClient: SteamClient) =>
  Effect.gen(function* (_) {
    const loginDetails = user.refreshToken
      ? ({ refreshToken: user.refreshToken } satisfies SteamUser.LogOnDetailsRefresh)
      : user.password
        ? ({ accountName: user.username, password: user.password } satisfies SteamUser.LogOnDetailsNamePass)
        : null;

    if (!loginDetails) {
      return yield* _(Effect.fail(new AuthError({ message: `No credentials found for ${user.username}` })));
    }

    yield* _(Effect.logInfo(`${user.username} logging in with ${user.refreshToken ? 'refresh token' : 'password'}`));

    yield* _(steamClient.logOn(loginDetails));
  });

const runCollectLoops = (user: UserContext, configStore: Store<ConfigContext>, sessionStore: Store<SessionContext>, state: UserWorkflowState) => {
  const checkLoggedOn = whenLoggedOn(state);

  const ownGamesLoop = checkLoggedOn(
    Effect.gen(function* (_) {
      const config = yield* _(configStore.get);
      yield* _(collectOwnGames(user, configStore, sessionStore));
      yield* _(Effect.sleep(`${config.refreshGames} millis`));
    }),
  ).pipe(Effect.repeat(Schedule.forever));

  const freeGamesLoop = checkLoggedOn(
    Effect.gen(function* (_) {
      yield* _(collectFreeGames(user, configStore, sessionStore));
      yield* _(Effect.sleep('1 minute'));
    }),
  ).pipe(Effect.repeat(Schedule.forever));

  return Effect.all([ownGamesLoop, freeGamesLoop], { concurrency: 'unbounded' });
};

const runPresenceAndIdle = (user: UserContext, steamClient: SteamClient, sessionStore: Store<SessionContext>, state: UserWorkflowState) =>
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

const makeUserSession = (user: UserContext, configStore: Store<ConfigContext>) =>
  Effect.gen(function* (_) {
    const steamClient = yield* _(SteamClient);
    const sessionDir = join(process.cwd(), 'sessions', user.username);
    const sessionStore = yield* _(makeStore(join(sessionDir, 'session.json'), SessionContext, INITIAL_SESSION, 600_000));

    const isPlaying = yield* _(Ref.make(false));

    const state: UserWorkflowState = {
      loggedOn: yield* _(Deferred.make<void>()),
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
          runCollectLoops(user, configStore, sessionStore, state),
          runPresenceAndIdle(user, steamClient, sessionStore, state),
          runLogin(user, steamClient).pipe(Effect.andThen(Effect.never)),
        ],
        { concurrency: 'unbounded' },
      ),
    );
  });

export const runUserWorkflow = (user: UserContext, configStore: Store<ConfigContext>) =>
  Effect.gen(function* (_) {
    const sessionDir = join(process.cwd(), 'sessions', user.username);
    yield* _(
      makeUserSession(user, configStore).pipe(
        Effect.provide(SteamClientLive(sessionDir)),
        Effect.scoped,
        Effect.retry(
          Schedule.spaced('10 seconds').pipe(Schedule.tapInput(() => Effect.logInfo(chalk`{yellow Retrying workflow for ${user.username}...}`))),
        ),
      ),
    );
  });
