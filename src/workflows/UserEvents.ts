import { createInterface } from 'node:readline';
import { chalk } from '@vegapunk/utilities';
import { Deferred, Effect, Ref } from 'effect';
import SteamTotp from 'steam-totp';
import SteamUser from 'steam-user';

import { DEFAULT_SLEEP_DURATION, RATE_LIMIT_MIN_MS, USER_OFFLINE_STATE } from '../core/constants';
import { ConfigStore, SessionStore, UserContext } from '../core/schemas';
import { collectOwnGames } from '../helpers/OwnGameHelper';
import { waitForConnection } from '../services/HttpService';
import { SteamClient, SteamEvent } from '../services/SteamService';

export interface InternalState {
  readonly isEnabled: boolean;
  readonly isPlaying: boolean;
  readonly family: Record<string, number>;
}

export interface UserWorkflowState {
  readonly loggedOn: Deferred.Deferred<void>;
  readonly state: Ref.Ref<InternalState>;
  readonly setGamesPlayed: (appIds: number[]) => Effect.Effect<void>;
  readonly reset: () => Effect.Effect<void>;
}

export const handleLoggedOn = (user: UserContext, steamClient: SteamClient, state: UserWorkflowState) =>
  Effect.gen(function* (_) {
    const configStore = yield* _(ConfigStore);
    const sessionStore = yield* _(SessionStore);

    const steamId = yield* _(steamClient.steamID);
    const steamIdString = steamId!.toString();
    yield* _(Effect.logInfo(chalk`{bold.yellow ${user.username} logged on!}`));
    yield* _(steamClient.setPersona(SteamUser.EPersonaState.Invisible));

    yield* _(
      configStore.update((cfg) => ({
        ...cfg,
        users: cfg.users.map((u) => (u.username === user.username ? { ...u, id: steamIdString } : u)),
      })),
    );

    const config = yield* _(configStore.get);
    yield* _(sessionStore.setDelay(config.refreshGames));

    yield* _(collectOwnGames(user));
    const sessionData = yield* _(sessionStore.get);
    yield* _(Effect.logInfo(`${user.username} owns ${sessionData.ownedGameList.length} games`));
    yield* _(Deferred.succeed(state.loggedOn, undefined));
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

const handleRateLimit = (user: UserContext) =>
  Effect.gen(function* (_) {
    const configStore = yield* _(ConfigStore);
    const cfg = yield* _(configStore.get);
    const sleepMs = Math.max(cfg.refreshGames, RATE_LIMIT_MIN_MS);
    yield* _(Effect.logWarning(`${user.username} Rate Limit Exceeded. Sleeping for ${sleepMs / 60000}m...`));
    yield* _(Effect.sleep(`${sleepMs} millis`));
  });

const handleLoggedInElsewhere = (user: UserContext) =>
  Effect.gen(function* (_) {
    yield* _(Effect.logWarning(`${user.username} Logged in elsewhere. Sleeping for 10m...`));
    yield* _(Effect.sleep('10 minutes'));
  });

const handleInvalidCredentials = (user: UserContext) =>
  Effect.gen(function* (_) {
    const configStore = yield* _(ConfigStore);
    yield* _(Effect.logError(`${user.username} Invalid credentials/token. Clearing refresh token.`));
    yield* _(
      configStore.update((cfg) => ({
        ...cfg,
        users: cfg.users.map((u) => (u.username === user.username ? { ...u, refreshToken: undefined } : u)),
      })),
    );
  });

export const handleError = (user: UserContext, error: Error & { eresult?: number }, state: UserWorkflowState) =>
  Effect.gen(function* (_) {
    yield* _(state.reset());
    yield* _(Effect.logError(chalk`{red ${user.username} disconnected}`, error));

    switch (error.eresult) {
      case SteamUser.EResult.RateLimitExceeded:
        yield* _(handleRateLimit(user));
        break;
      case SteamUser.EResult.LoggedInElsewhere:
      case SteamUser.EResult.LogonSessionReplaced:
      case SteamUser.EResult.AlreadyLoggedInElsewhere:
        yield* _(handleLoggedInElsewhere(user));
        break;
      case SteamUser.EResult.AccessDenied:
      case SteamUser.EResult.InvalidPassword:
        yield* _(handleInvalidCredentials(user));
        break;
      case SteamUser.EResult.NoConnection:
      case SteamUser.EResult.ServiceUnavailable:
        yield* _(waitForConnection());
        break;
    }

    yield* _(Effect.logInfo(chalk`{yellow ${user.username} session ended, restarting...}`));
    yield* _(Effect.fail(error));
  });

export const handleVacBans = (user: UserContext, event: Extract<SteamEvent, { type: 'vacBans' }>) =>
  Effect.gen(function* (_) {
    const configStore = yield* _(ConfigStore);
    const sessionStore = yield* _(SessionStore);

    if (event.numBans > 0) {
      yield* _(Effect.logInfo(chalk`{bold.red ${user.username} has ${event.numBans} VAC ban(s)}`));
      yield* _(Effect.logInfo(`- ${event.appids.join(', ').trim()}`));

      const config = yield* _(configStore.get);
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
    const { family, isEnabled } = yield* _(Ref.get(state.state));
    const userId = event.steamId.toString();
    const steamId = yield* _(steamClient.steamID);
    const selfId = steamId!.toString();

    const isSelf = selfId === userId || user.id === userId;
    const isFamilyMember = family[userId] !== undefined;

    if (isSelf || !isFamilyMember) return;

    const personaState = event.user.persona_state;
    // Skip if we don't have a valid persona state update and it's not the first time
    if (family[userId] !== -1 && personaState === null) return;

    const userPersona = personaState ?? SteamUser.EPersonaState.Offline;
    const isUserOffline = USER_OFFLINE_STATE.includes(userPersona);

    // Update family state tracking
    yield* _(Ref.update(state.state, (s) => ({ ...s, family: { ...s.family, [userId]: userPersona } })));

    if (isUserOffline) return;

    // If a family member is online, disable idling
    if (isEnabled) {
      yield* _(Ref.update(state.state, (s) => ({ ...s, isEnabled: false })));
      yield* _(state.setGamesPlayed([]));

      const playerName = event.user.player_name || 'FamilyMember';
      yield* _(Effect.logInfo(chalk`{yellow ${user.username} paused: ${playerName} is online}`));
    }
  });

export const handleSteamEvent = (event: SteamEvent, user: UserContext, steamClient: SteamClient, state: UserWorkflowState) =>
  Effect.gen(function* (_) {
    const configStore = yield* _(ConfigStore);

    switch (event.type) {
      case 'loggedOn':
        return yield* _(handleLoggedOn(user, steamClient, state));
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
        return yield* _(handleError(user, event.error, state));
      case 'vacBans':
        return yield* _(handleVacBans(user, event));
      case 'user':
        return yield* _(handleUserUpdate(user, event, steamClient, state));
    }
  });
