import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { waitForConnection } from '@vegapunk/request';
import { chalk } from '@vegapunk/utilities';
import { Effect, Ref, Schedule, Stream } from 'effect';
import SteamTotp from 'steam-totp';
import SteamUser from 'steam-user';

import { ConfigContext, SessionData, UserContext } from '../schemas/Domain';
import { collectFreeGames } from '../services/FreeGameService';
import { scanGames } from '../services/GameScannerService';
import { startIdleGames } from '../services/IdleService';
import { SteamClient, SteamClientLive, SteamEvent } from '../services/SteamService';
import { makeStore, Store } from '../services/StoreService';

const initialSessionData: SessionData = {
  lastLoop: 0,
  lastPage: 1,
  freeGameIds: [],
  freeGameList: [],
  freeGameLength: 0,
  forceRegister: false,
  ownedGameList: [],
  bannedGameIds: [],
};

const USER_OFFLINE_STATE = [SteamUser.EPersonaState.Offline, SteamUser.EPersonaState.Invisible] as const;

const handleSteamEvent = (
  event: SteamEvent,
  user: UserContext,
  steamClient: SteamClient,
  configStore: Store<ConfigContext>,
  sessionStore: Store<SessionData>,
  state: {
    isLoggedOn: Ref.Ref<boolean>;
    isEnabled: Ref.Ref<boolean>;
    familyState: Ref.Ref<Record<string, number>>;
    setGamesPlayed: (appIds: number[]) => Effect.Effect<void>;
  },
) =>
  Effect.gen(function* (_) {
    switch (event.type) {
      case 'loggedOn': {
        const sid = yield* _(steamClient.steamID);
        const steamID = sid!.toString();
        yield* _(Effect.logInfo(chalk`{bold.yellow ${user.username} logged on!}`));
        yield* _(Ref.set(state.isLoggedOn, true));
        yield* _(steamClient.setPersona(SteamUser.EPersonaState.Invisible));

        yield* _(
          configStore.update((cfg) => ({
            ...cfg,
            users: cfg.users.map((u) => (u.username === user.username ? { ...u, id: steamID } : u)),
          })),
        );

        const config = yield* _(configStore.get);
        yield* _(sessionStore.setDelay(config.refreshGames));

        yield* _(scanGames(sessionStore, user, config.whitelistGameIds, config.blacklistGameIds));
        const sessionData = yield* _(sessionStore.get);
        yield* _(Effect.logInfo(`${user.username} owns ${sessionData.ownedGameList.length} games`));
        break;
      }

      case 'refreshToken':
        yield* _(
          configStore.update((cfg) => ({
            ...cfg,
            users: cfg.users.map((u) => (u.username === user.username ? { ...u, refreshToken: event.token } : u)),
          })),
        );
        break;

      case 'steamGuard':
        if (event.lastCodeWrong) {
          yield* _(Effect.logInfo(`${user.username} Steam Guard wrong`));
          yield* _(Effect.sleep('10 seconds'));
        }
        yield* _(Effect.logInfo(`${user.username} needs Steam Guard`));
        if (user.secret) {
          const code = SteamTotp.generateAuthCode(user.secret);
          yield* _(Effect.logInfo(`${user.username} used ${code} as Steam Guard`));
          event.callback(code);
        } else {
          yield* _(
            Effect.async<void>((resume) => {
              const rl = createInterface({ input: process.stdin, output: process.stdout });
              const prompt = `${user.username} Steam Guard${!event.domain ? ' App' : ''} Code: `;
              rl.question(prompt, (code) => {
                rl.close();
                event.callback(code);
                resume(Effect.void);
              });
            }),
          );
        }
        break;

      case 'error':
        yield* _(Effect.logError(chalk`{red ${user.username} disconnected: ${event.error.message}}`));
        yield* _(Ref.set(state.isLoggedOn, false));
        yield* _(Ref.set(state.isEnabled, false));

        if (event.error.eresult) {
          switch (event.error.eresult) {
            case SteamUser.EResult.RateLimitExceeded: {
              const cfg = yield* _(configStore.get);
              const sleepMs = Math.max(cfg.refreshGames, 1_800_000);
              yield* _(Effect.logWarning(`${user.username} Rate Limit Exceeded. Sleeping for ${sleepMs / 60000}m...`));
              yield* _(Effect.sleep(`${sleepMs} millis`));
              break;
            }
            case SteamUser.EResult.LoggedInElsewhere:
            case SteamUser.EResult.LogonSessionReplaced:
            case SteamUser.EResult.AlreadyLoggedInElsewhere:
              yield* _(Effect.logWarning(`${user.username} Logged in elsewhere. Sleeping for 10m...`));
              yield* _(Effect.sleep('10 minutes'));
              break;
            case SteamUser.EResult.AccessDenied:
            case SteamUser.EResult.InvalidPassword:
              yield* _(Effect.logError(`${user.username} Invalid credentials/token. Clearing refresh token.`));
              yield* _(
                configStore.update((cfg) => ({
                  ...cfg,
                  users: cfg.users.map((u) => (u.username === user.username ? { ...u, refreshToken: undefined } : u)),
                })),
              );
              break;
            case SteamUser.EResult.NoConnection:
            case SteamUser.EResult.ServiceUnavailable:
              yield* _(Effect.logWarning(`${user.username} connection issue. Waiting for connection...`));
              yield* _(Effect.tryPromise(() => waitForConnection()));
              break;
          }
        }

        yield* _(Effect.logInfo(chalk`{yellow ${user.username} relogged}`));
        yield* _(Effect.sleep('10 seconds'));

        yield* _(state.setGamesPlayed([]));
        yield* _(Ref.set(state.isEnabled, false));

        yield* _(Effect.fail(event.error));
        break;

      case 'vacBans': {
        const config = yield* _(configStore.get);
        if (event.numBans > 0) {
          yield* _(Effect.logInfo(chalk`{bold.red ${user.username} has ${event.numBans} VAC ban(s)}`));
          yield* _(Effect.logInfo(`- ${event.appids.join(', ').trim()}`));
          if (config.skipBannedGames) {
            yield* _(sessionStore.update((data) => ({ ...data, bannedGameIds: event.appids })));
          }
        } else {
          yield* _(sessionStore.update((data) => ({ ...data, bannedGameIds: [] })));
          yield* _(Effect.logInfo(`${user.username} has no VAC bans`));
        }
        break;
      }

      case 'user': {
        const family = yield* _(Ref.get(state.familyState));
        const userId = event.sid.toString();
        const sid = yield* _(steamClient.steamID);
        const selfId = sid?.toString();

        if ((selfId && selfId === userId) || user.id === userId || typeof family[userId] !== 'number') {
          return;
        }

        if (family[userId] !== -1 && event.user.persona_state === null) {
          return;
        }

        const userPersona = event.user.persona_state ?? SteamUser.EPersonaState.Offline;
        const isUserOffline = USER_OFFLINE_STATE.includes(userPersona);

        if (family[userId] === -1 || event.user.persona_state !== undefined) {
          const newFamilyState = { ...family, [userId]: userPersona };
          yield* _(Ref.set(state.familyState, newFamilyState));
        }

        const currentEnabled = yield* _(Ref.get(state.isEnabled));
        if (currentEnabled && !isUserOffline) {
          yield* _(Ref.set(state.isEnabled, false));
          yield* _(state.setGamesPlayed([]));

          const playerName = event.user.player_name || 'FamilyMember';
          yield* _(Effect.logInfo(chalk`{yellow ${user.username} sleeping, reason: ${playerName} is online}`));
        }
        break;
      }
    }
  });

const makeUserSession = (user: UserContext, configStore: Store<ConfigContext>, registrationSemaphore: Effect.Semaphore) =>
  Effect.gen(function* (_) {
    const steamClient = yield* _(SteamClient);
    const sessionDir = join(process.cwd(), 'sessions', user.username);
    const sessionStore = yield* _(makeStore(join(sessionDir, 'session.json'), SessionData, initialSessionData, 600_000));

    const isLoggedOn = yield* _(Ref.make(false));
    const isEnabled = yield* _(Ref.make(false));
    const familyState = yield* _(Ref.make(Object.fromEntries((user.family ?? []).map((r: string) => [r, -1]))));
    const isPlaying = yield* _(Ref.make(false));

    const setGamesPlayed = (appIds: number[]) =>
      Effect.gen(function* (_) {
        const hasIds = appIds.length > 0;
        const currentPlaying = yield* _(Ref.get(isPlaying));

        if (!hasIds && !currentPlaying) return;

        yield* _(steamClient.setPersona(hasIds ? SteamUser.EPersonaState.Online : SteamUser.EPersonaState.Invisible));
        yield* _(steamClient.gamesPlayed(appIds));
        yield* _(Ref.set(isPlaying, hasIds));
      });

    const handleEvents = steamClient.events.pipe(
      Stream.runForEach((event) =>
        handleSteamEvent(event, user, steamClient, configStore, sessionStore, {
          isLoggedOn,
          isEnabled,
          familyState,
          setGamesPlayed,
        }),
      ),
    );

    const login = Effect.gen(function* (_) {
      yield* _(Effect.tryPromise(() => waitForConnection()));

      const loginDetails = user.refreshToken ? { refreshToken: user.refreshToken } : { accountName: user.username, password: user.password };

      yield* _(Effect.logInfo(`${user.username} logging in with ${user.refreshToken ? 'refresh token' : 'password'}`));

      yield* _(
        steamClient.logOn(loginDetails),
        Effect.zipRight(steamClient.waitForLogOn),
        Effect.timeout('1 minute'),
        Effect.catchTag('TimeoutException', () =>
          Effect.gen(function* (_) {
            yield* _(Effect.logError(`${user.username} login timed out`));
            return yield* _(Effect.fail(new Error('Login timed out')));
          }),
        ),
      );
    });

    const mainLoop = Effect.gen(function* (_) {
      let nextIdleTime = 0;
      let nextGameRefreshTime = 0;

      while (true) {
        const logged = yield* _(Ref.get(isLoggedOn));
        if (!logged) {
          yield* _(Effect.sleep('5 seconds'));
          continue;
        }

        const config = yield* _(configStore.get);
        const now = Date.now();

        if (config.fetchFreeGames || user.fetchFreeGames) {
          yield* _(collectFreeGames(sessionStore, user, config.blacklistGameIds, registrationSemaphore, config.refreshGames));
        }

        if (now > nextGameRefreshTime) {
          yield* _(scanGames(sessionStore, user, config.whitelistGameIds, config.blacklistGameIds));
          nextGameRefreshTime = now + config.refreshGames;
        }

        const family = yield* _(Ref.get(familyState));
        const hasFamilyOnline = Object.values(family).some((state) => (state as number) > 0);
        const playing = yield* _(Ref.get(isPlaying));

        if (hasFamilyOnline) {
          yield* _(Ref.set(isEnabled, false));
        } else if (!playing) {
          const sid = yield* _(steamClient.steamID);
          if (sid) {
            const communityUser = yield* _(steamClient.getCommunityUser(sid));
            if (communityUser && typeof communityUser.onlineState === 'string') {
              const shouldEnable = communityUser.onlineState === 'offline';
              yield* _(Ref.set(isEnabled, shouldEnable));
            }
          }
        }

        const enabled = yield* _(Ref.get(isEnabled));
        if (enabled && now > nextIdleTime) {
          nextIdleTime = yield* _(startIdleGames(sessionStore, user.username));
          yield* _(Ref.set(isPlaying, true));
        } else if (!enabled) {
          if (playing) {
            yield* _(setGamesPlayed([]));
          }
        }

        yield* _(Effect.sleep('1 minute'));
      }
    });

    yield* _(Effect.all([login, handleEvents, mainLoop], { concurrency: 'unbounded' }), Effect.ensuring(sessionStore.dispose));
  });

export const runUserWorkflow = (user: UserContext, configStore: Store<ConfigContext>, registrationSemaphore: Effect.Semaphore) =>
  Effect.scoped(
    Effect.gen(function* (_) {
      const sessionDir = join(process.cwd(), 'sessions', user.username);
      yield* _(
        makeUserSession(user, configStore, registrationSemaphore),
        Effect.provide(SteamClientLive(sessionDir)),
        Effect.retry(Schedule.exponential('5 seconds').pipe(Schedule.union(Schedule.spaced('1 minute')))),
      );
    }),
  );
