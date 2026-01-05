import { createInterface } from 'node:readline';
import { waitForConnection } from '@vegapunk/request';
import { chalk } from '@vegapunk/utilities';
import { Effect, Ref } from 'effect';
import SteamTotp from 'steam-totp';
import SteamUser from 'steam-user';

import { DEFAULT_SLEEP_DURATION, RATE_LIMIT_MIN_MS } from '../core/constants';
import { ConfigContext, SessionData, USER_OFFLINE_STATE, UserContext } from '../core/schemas';
import { collectOwnGames } from '../services/OwnGameService';
import { SteamClient, SteamEvent } from '../services/SteamService';
import { Store } from '../services/StoreService';

export interface UserWorkflowState {
  readonly isLoggedOn: Ref.Ref<boolean>;
  readonly isEnabled: Ref.Ref<boolean>;
  readonly isPlaying: Ref.Ref<boolean>;
  readonly familyState: Ref.Ref<Record<string, number>>;
  readonly setGamesPlayed: (appIds: number[]) => Effect.Effect<void>;
  readonly reset: () => Effect.Effect<void>;
}

export const handleLoggedOn = (
  user: UserContext,
  steamClient: SteamClient,
  configStore: Store<ConfigContext>,
  sessionStore: Store<SessionData>,
  state: UserWorkflowState,
) =>
  Effect.gen(function* (_) {
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

    yield* _(collectOwnGames(sessionStore, user, config.whitelistGameIds, config.blacklistGameIds));
    const sessionData = yield* _(sessionStore.get);
    yield* _(Effect.logInfo(`${user.username} owns ${sessionData.ownedGameList.length} games`));
  });

export const handleSteamGuard = (user: UserContext, event: Extract<SteamEvent, { type: 'steamGuard' }>) =>
  Effect.gen(function* (_) {
    if (event.lastCodeWrong) {
      yield* _(Effect.logInfo(`${user.username} Steam Guard wrong`));
      yield* _(Effect.sleep(DEFAULT_SLEEP_DURATION));
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
  });

export const handleError = (user: UserContext, error: Error & { eresult?: number }, configStore: Store<ConfigContext>, state: UserWorkflowState) =>
  Effect.gen(function* (_) {
    yield* _(Effect.logError(chalk`{red ${user.username} disconnected}`, error));
    yield* _(state.reset());

    if (error.eresult) {
      switch (error.eresult) {
        case SteamUser.EResult.RateLimitExceeded: {
          const cfg = yield* _(configStore.get);
          const sleepMs = Math.max(cfg.refreshGames, RATE_LIMIT_MIN_MS);
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
          yield* _(Effect.tryPromise(() => waitForConnection()));
          break;
      }
    }

    yield* _(Effect.logInfo(chalk`{yellow ${user.username} relogged}`));
    yield* _(Effect.sleep(DEFAULT_SLEEP_DURATION));

    yield* _(state.reset());

    yield* _(Effect.fail(error));
  });

export const handleVacBans = (
  user: UserContext,
  event: Extract<SteamEvent, { type: 'vacBans' }>,
  configStore: Store<ConfigContext>,
  sessionStore: Store<SessionData>,
) =>
  Effect.gen(function* (_) {
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
  });

export const handleUserUpdate = (
  user: UserContext,
  event: Extract<SteamEvent, { type: 'user' }>,
  steamClient: SteamClient,
  state: UserWorkflowState,
) =>
  Effect.gen(function* (_) {
    const family = yield* _(Ref.get(state.familyState));
    const userId = event.sid.toString();
    const sid = yield* _(steamClient.steamID);
    const selfId = sid?.toString();

    const isSelf = selfId === userId || user.id === userId;
    const isFamilyMember = family[userId] !== undefined;

    if (isSelf || !isFamilyMember) return;

    const personaState = event.user.persona_state;
    if (family[userId] !== -1 && personaState === null) return;

    const userPersona = personaState ?? SteamUser.EPersonaState.Offline;
    const isUserOffline = USER_OFFLINE_STATE.includes(userPersona);

    if (family[userId] === -1 || personaState !== undefined) {
      yield* _(Ref.update(state.familyState, (f) => ({ ...f, [userId]: userPersona })));
    }

    if (isUserOffline) return;

    const currentEnabled = yield* _(Ref.get(state.isEnabled));
    if (currentEnabled) {
      yield* _(Ref.set(state.isEnabled, false));
      yield* _(state.setGamesPlayed([]));

      const playerName = event.user.player_name || 'FamilyMember';
      yield* _(Effect.logInfo(chalk`{yellow ${user.username} sleeping, reason: ${playerName} is online}`));
    }
  });

export const handleSteamEvent = (
  event: SteamEvent,
  user: UserContext,
  steamClient: SteamClient,
  configStore: Store<ConfigContext>,
  sessionStore: Store<SessionData>,
  state: UserWorkflowState,
) =>
  Effect.gen(function* (_) {
    switch (event.type) {
      case 'loggedOn':
        return yield* _(handleLoggedOn(user, steamClient, configStore, sessionStore, state));
      case 'refreshToken':
        return yield* _(
          configStore.update((cfg) => ({
            ...cfg,
            users: cfg.users.map((u) => (u.username === user.username ? { ...u, refreshToken: event.token } : u)),
          })),
        );
      case 'steamGuard':
        return yield* _(handleSteamGuard(user, event));
      case 'error':
        return yield* _(handleError(user, event.error, configStore, state));
      case 'vacBans':
        return yield* _(handleVacBans(user, event, configStore, sessionStore));
      case 'user':
        return yield* _(handleUserUpdate(user, event, steamClient, state));
    }
  });
