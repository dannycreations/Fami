import { Cause, Context, Duration, Effect, Layer, Scope, Stream } from 'effect';
import SteamUser from 'steam-user';
import SteamCommunity from 'steamcommunity';
import CSteamUser from 'steamcommunity/classes/CSteamUser';

import { SteamError } from '../core/errors';
import { UserStatus } from '../core/schemas';

export type SteamEvent =
  | {
      readonly type: 'loggedOn';
    }
  | {
      readonly type: 'error';
      readonly error: Error & { eresult?: number };
    }
  | {
      readonly type: 'refreshToken';
      readonly token: string;
    }
  | {
      readonly type: 'steamGuard';
      readonly domain: string | null;
      readonly callback: (code: string) => void;
      readonly lastCodeWrong: boolean;
    }
  | {
      readonly type: 'user';
      readonly steamId: NonNullable<SteamUser['steamID']>;
      readonly user: UserStatus;
    }
  | {
      readonly type: 'vacBans';
      readonly numBans: number;
      readonly appids: number[];
    };

export interface SteamClient {
  readonly user: SteamUser;
  readonly community: SteamCommunity;
  readonly events: Stream.Stream<SteamEvent, never>;
  readonly steamID: Effect.Effect<NonNullable<SteamUser['steamID']> | null>;
  readonly logOn: (details: Parameters<SteamUser['logOn']>[0]) => Effect.Effect<void, SteamError | Cause.TimeoutException>;
  readonly logOff: Effect.Effect<void>;
  readonly setPersona: (state: SteamUser.EPersonaState) => Effect.Effect<void>;
  readonly gamesPlayed: (appIds: number[]) => Effect.Effect<void>;
  readonly getCommunityUser: (id: NonNullable<SteamUser['steamID']>) => Effect.Effect<CSteamUser | null>;
  readonly getUserOwnedApps: (
    id: NonNullable<SteamUser['steamID']>,
    options: SteamUser.GetUserOwnedAppsOptions,
  ) => Effect.Effect<SteamUser.UserOwnedApps, SteamError | Cause.TimeoutException>;
  readonly getProductInfo: (apps: number[], packages: number[]) => Effect.Effect<SteamUser.ProductInfo, SteamError | Cause.TimeoutException>;
  readonly requestFreeLicense: (appIDs: number[]) => Effect.Effect<void, SteamError | Cause.TimeoutException>;
  readonly updatePersonaAndGames: (state: SteamUser.EPersonaState, appIds: number[]) => Effect.Effect<void>;
}

const createEventStream = (user: SteamUser, community: SteamCommunity) =>
  Stream.async<SteamEvent>((emit) => {
    const handlers: Record<string, (...args: any[]) => void> = {
      webSession: (_sessionID: string, cookies: string[]) => community.setCookies(cookies),
      loggedOn: () => emit.single({ type: 'loggedOn' }),
      error: (error: Error & { eresult?: number }) => emit.single({ type: 'error', error }),
      refreshToken: (token: string) => emit.single({ type: 'refreshToken', token }),
      steamGuard: (domain: string | null, callback: (code: string) => void, lastCodeWrong: boolean) =>
        emit.single({ type: 'steamGuard', domain, callback, lastCodeWrong }),
      user: (steamId: NonNullable<SteamUser['steamID']>, user: UserStatus) =>
        emit.single({
          type: 'user',
          steamId,
          user: {
            persona_state: user?.persona_state ?? null,
            player_name: user?.player_name ?? null,
          },
        }),
      vacBans: (numBans: number, appids: number[]) => emit.single({ type: 'vacBans', numBans, appids }),
    };

    Object.entries(handlers).forEach(([event, handler]) => user.on(event as any, handler));

    return Effect.sync(() => {
      // Suppress late errors
      user.once('error', () => {});
      Object.entries(handlers).forEach(([event, handler]) => user.removeListener(event as any, handler));
    });
  }).pipe(
    Stream.tap((event) => Effect.annotateLogs(Effect.logTrace(`Steam Event: ${event.type}`), 'event', JSON.stringify(event))),
    Stream.tapError((error) => Effect.logError('Steam event stream error', error)),
  );

const createSteamClient = (dataDirectory: string): Effect.Effect<SteamClient, never, Scope.Scope> =>
  Effect.gen(function* () {
    const user = new SteamUser({ dataDirectory, renewRefreshTokens: true, autoRelogin: false });
    const community = new SteamCommunity({ timeout: 10_000 });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        user.logOff();
        user.removeAllListeners();
        community.removeAllListeners();
      }),
    );

    const wrapPromise = <A>(
      promise: () => Promise<A>,
      timeout: Duration.DurationInput = '30 seconds',
    ): Effect.Effect<A, SteamError | Cause.TimeoutException> =>
      Effect.tryPromise({
        try: promise,
        catch: (error) => {
          const err = error as Error & { eresult?: number };
          // Suppress internal "timed out" errors
          return err.message.toLowerCase().includes('timed out')
            ? new Cause.TimeoutException()
            : new SteamError({
                message: err.message,
                eresult: err.eresult,
                cause: error,
              });
        },
      }).pipe(Effect.timeout(timeout));

    return {
      user,
      community,
      events: createEventStream(user, community),
      steamID: Effect.sync(() => user.steamID),
      logOn: (details) =>
        Effect.async<void, SteamError>((resume) => {
          const cleanup = () => {
            user.removeListener('loggedOn', onLoggedOn);
            user.removeListener('error', onError);
          };
          const onLoggedOn = () => {
            cleanup();
            resume(Effect.void);
          };
          const onError = (error: Error & { eresult?: number }) => {
            cleanup();
            resume(
              Effect.fail(
                new SteamError({
                  message: error.message || 'Login failed',
                  cause: error,
                  eresult: error.eresult,
                }),
              ),
            );
          };

          user.once('loggedOn', onLoggedOn);
          user.once('error', onError);
          user.logOn(details);

          return Effect.sync(cleanup);
        }).pipe(Effect.timeout('1 minute')),
      logOff: Effect.sync(() => user.logOff()),
      setPersona: (state) => Effect.sync(() => user.setPersona(state)),
      gamesPlayed: (appIds) => Effect.sync(() => user.gamesPlayed(appIds)),
      getCommunityUser: (id) =>
        Effect.async<CSteamUser | null>((resume) => {
          community.getSteamUser(id, (error, user) => {
            resume(Effect.succeed(error ? null : user));
          });
        }).pipe(
          Effect.timeout('10 seconds'),
          Effect.catchTag('TimeoutException', () => Effect.succeed(null)),
        ),
      getUserOwnedApps: (steamID, options) => wrapPromise(() => user.getUserOwnedApps(steamID, options), '1 minute'),
      getProductInfo: (apps, packages) => wrapPromise(() => user.getProductInfo(apps, packages)),
      requestFreeLicense: (appIDs) => wrapPromise(() => user.requestFreeLicense(appIDs)),
      updatePersonaAndGames: (state, appIds) =>
        Effect.sync(() => {
          user.setPersona(state);
          user.gamesPlayed(appIds);
        }),
    };
  });

export class SteamClientTag extends Context.Tag('@services/SteamLayer')<SteamClientTag, SteamClient>() {}

export const SteamClientLayer = (dataDirectory: string) => Layer.scoped(SteamClientTag, createSteamClient(dataDirectory));
