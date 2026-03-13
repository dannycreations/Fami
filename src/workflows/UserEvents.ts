import { createInterface } from 'node:readline';
import { chalk } from '@vegapunk/utilities';
import { Deferred, Effect, HashSet, Ref } from 'effect';
import SteamTotp from 'steam-totp';
import SteamUser from 'steam-user';

import { ConfigStoreTag, SessionStore, UserContext } from '../core/schemas';
import { getRateLimitSleep } from '../core/utils';
import { collectOwnGames } from '../helpers/OwnGameHelper';
import { SteamClient, SteamEvent } from '../services/SteamService';
import { waitForConnection } from '../structures/HttpClient';

export const DEFAULT_SLEEP_DURATION = '10 seconds';
export const USER_OFFLINE_STATE = [SteamUser.EPersonaState.Offline, SteamUser.EPersonaState.Invisible] as const;

export interface InternalState {
  readonly isEnabled: boolean;
  readonly isPlaying: boolean;
  readonly family: Record<string, number>;
}

export interface UserWorkflowState {
  readonly loggedOn: Deferred.Deferred<void, never>;
  readonly state: Ref.Ref<InternalState>;
  readonly setGamesPlayed: (appIds: number[]) => Effect.Effect<void>;
  readonly reset: () => Effect.Effect<void>;
}

export const handleLoggedOn = (user: UserContext, steamClient: SteamClient, state: UserWorkflowState) =>
  Effect.gen(function* () {
    const configStore = yield* ConfigStoreTag;
    const sessionStore = yield* SessionStore;

    const steamId = yield* steamClient.steamID;
    const steamIdString = steamId!.toString();

    yield* Effect.logInfo(chalk`{bold.yellow ${user.username} logged on!}`);
    yield* steamClient.setPersona(SteamUser.EPersonaState.Invisible);

    yield* configStore.update((cfg) => ({
      ...cfg,
      users: cfg.users.map((u) => (u.username === user.username ? { ...u, id: steamIdString } : u)),
    }));

    const config = yield* configStore.get;
    yield* sessionStore.setDelay(config.refreshGames);

    const hasFamily = user.family && user.family.length > 0;

    if (hasFamily) {
      yield* Effect.promise(() => steamClient.user.getPersonas([...user.family!]));
    }

    yield* collectOwnGames(user);

    const sessionData = yield* sessionStore.get;
    yield* Effect.logInfo(`${user.username} owns ${sessionData.ownedGameList.length} games`);
    yield* Deferred.succeed(state.loggedOn, undefined);
  });

export const handleSteamGuard = (user: UserContext, event: Extract<SteamEvent, { _tag: 'SteamGuard' }>) =>
  Effect.gen(function* () {
    if (event.lastCodeWrong) {
      yield* Effect.logInfo(`${user.username} Steam Guard wrong`);
      yield* Effect.sleep(DEFAULT_SLEEP_DURATION);
    }

    yield* Effect.logInfo(`${user.username} needs Steam Guard`);

    if (user.secret) {
      const code = SteamTotp.generateAuthCode(user.secret);
      yield* Effect.logInfo(`${user.username} used ${code} as Steam Guard`);
      event.callback(code);
      return;
    }

    yield* Effect.async<void>((resume) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const prompt = `${user.username} Steam Guard${!event.domain ? ' App' : ''} Code: `;

      rl.question(prompt, (code) => {
        rl.close();
        event.callback(code);
        resume(Effect.void);
      });
    });
  });

const handleRateLimit = (user: UserContext) =>
  Effect.gen(function* () {
    const configStore = yield* ConfigStoreTag;
    const cfg = yield* configStore.get;
    const sleepMs = getRateLimitSleep(cfg.refreshGames);
    yield* Effect.logWarning(`${user.username} Rate Limit Exceeded. Sleeping for ${sleepMs / 60000}m...`);
    yield* Effect.sleep(`${sleepMs} millis`);
  });

const handleLoggedInElsewhere = (user: UserContext) =>
  Effect.gen(function* () {
    yield* Effect.logWarning(`${user.username} Logged in elsewhere. Sleeping for 10m...`);
    yield* Effect.sleep('10 minutes');
  });

const handleInvalidCredentials = (user: UserContext) =>
  Effect.gen(function* () {
    const configStore = yield* ConfigStoreTag;
    yield* Effect.logError(`${user.username} Invalid credentials/token. Clearing refresh token.`);
    yield* configStore.update((cfg) => ({
      ...cfg,
      users: cfg.users.map((u) => (u.username === user.username ? { ...u, refreshToken: undefined } : u)),
    }));
  });

export const handleError = (user: UserContext, error: Error & { eresult?: number }, state: UserWorkflowState) =>
  Effect.gen(function* () {
    yield* state.reset();
    yield* Effect.logError(chalk`{red ${user.username} disconnected}`, error);

    const eresult = error.eresult;

    switch (eresult) {
      case SteamUser.EResult.RateLimitExceeded: {
        yield* handleRateLimit(user);
        break;
      }
      case SteamUser.EResult.LoggedInElsewhere:
      case SteamUser.EResult.LogonSessionReplaced:
      case SteamUser.EResult.AlreadyLoggedInElsewhere: {
        yield* handleLoggedInElsewhere(user);
        break;
      }
      case SteamUser.EResult.AccessDenied:
      case SteamUser.EResult.InvalidPassword: {
        yield* handleInvalidCredentials(user);
        break;
      }
      case SteamUser.EResult.NoConnection:
      case SteamUser.EResult.ServiceUnavailable: {
        yield* waitForConnection();
        break;
      }
    }

    yield* Effect.logInfo(chalk`{yellow ${user.username} session ended, restarting...}`);
    yield* Effect.fail(error);
  });

export const handleVacBans = (user: UserContext, event: Extract<SteamEvent, { _tag: 'VacBans' }>) =>
  Effect.gen(function* () {
    const configStore = yield* ConfigStoreTag;
    const sessionStore = yield* SessionStore;

    const hasBans = event.numBans > 0;

    if (!hasBans) {
      yield* sessionStore.update((data) => ({ ...data, bannedGameIds: HashSet.empty() }));
      return yield* Effect.logInfo(`${user.username} has no VAC bans`);
    }

    yield* Effect.logInfo(chalk`{bold.red ${user.username} has ${event.numBans} VAC_ban(s)}`);
    yield* Effect.logInfo(`- ${event.appids.join(', ').trim()}`);

    const config = yield* configStore.get;
    const shouldSkipBanned = config.skipBannedGames;

    if (shouldSkipBanned) {
      yield* sessionStore.update((data) => ({
        ...data,
        bannedGameIds: HashSet.fromIterable(event.appids),
      }));
    }
  });

export const handleUserUpdate = (
  user: UserContext,
  event: Extract<SteamEvent, { _tag: 'User' }>,
  steamClient: SteamClient,
  state: UserWorkflowState,
) =>
  Effect.gen(function* () {
    const { family, isEnabled, isPlaying } = yield* Ref.get(state.state);
    const userId = event.steamId.toString();
    const personaState = event.user.persona_state;

    const isUserInFamily = userId in family;
    if (!isUserInFamily) {
      return;
    }

    const isPersonaStateUnknown = family[userId] !== -1 && personaState === null;
    if (isPersonaStateUnknown) {
      return;
    }

    const steamId = yield* steamClient.steamID;
    const selfId = steamId?.toString();
    if (selfId === userId) {
      return;
    }

    if (user.id === userId) {
      return;
    }

    const userPersona = personaState ?? SteamUser.EPersonaState.Offline;
    const isUserOffline = (USER_OFFLINE_STATE as readonly number[]).includes(userPersona);

    const nextFamilyState = { ...family, [userId]: userPersona };
    yield* Ref.update(state.state, (s) => ({ ...s, family: nextFamilyState }));

    if (isUserOffline) {
      return;
    }

    const shouldSkipUpdate = !isEnabled && !isPlaying;
    if (shouldSkipUpdate) {
      return;
    }

    yield* Ref.update(state.state, (s) => ({ ...s, isEnabled: false, isPlaying: false }));
    yield* state.setGamesPlayed([]);

    const playerName = event.user.player_name || 'FamilyMember';
    yield* Effect.logInfo(chalk`{yellow ${user.username} paused: ${playerName} is online}`);
  });

export const handleSteamEvent = (event: SteamEvent, user: UserContext, steamClient: SteamClient, state: UserWorkflowState) =>
  Effect.gen(function* () {
    const configStore = yield* ConfigStoreTag;

    switch (event._tag) {
      case 'LoggedOn': {
        return yield* handleLoggedOn(user, steamClient, state);
      }
      case 'RefreshToken': {
        return yield* configStore.update((cfg) => ({
          ...cfg,
          users: cfg.users.map((u) => {
            if (u.username !== user.username) {
              return u;
            }

            return { ...u, refreshToken: event.token };
          }),
        }));
      }
      case 'SteamGuard': {
        return yield* handleSteamGuard(user, event);
      }
      case 'Error': {
        return yield* handleError(user, event.error, state);
      }
      case 'VacBans': {
        return yield* handleVacBans(user, event);
      }
      case 'User': {
        return yield* handleUserUpdate(user, event, steamClient, state);
      }
    }
  });
