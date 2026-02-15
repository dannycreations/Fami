import { Cause, Context, Duration, Effect, Layer, Scope, Stream } from 'effect';
import SteamUser from 'steam-user';
import SteamCommunity from 'steamcommunity';

import { isSteamErrorTimeout, RetryTimeoutPolicy, SteamError } from '../core/errors';

import type CSteamUser from 'steamcommunity/classes/CSteamUser';
import type { UserStatus } from '../core/schemas';

export type SteamEvent =
  | {
      readonly _tag: 'LoggedOn';
    }
  | {
      readonly _tag: 'Error';
      readonly error: Error & { readonly eresult?: number };
    }
  | {
      readonly _tag: 'RefreshToken';
      readonly token: string;
    }
  | {
      readonly _tag: 'SteamGuard';
      readonly domain: string | null;
      readonly callback: (code: string) => void;
      readonly lastCodeWrong: boolean;
    }
  | {
      readonly _tag: 'User';
      readonly steamId: NonNullable<SteamUser['steamID']>;
      readonly user: UserStatus;
    }
  | {
      readonly _tag: 'VacBans';
      readonly numBans: number;
      readonly appids: ReadonlyArray<number>;
    };

export interface SteamClient {
  readonly user: SteamUser;
  readonly community: SteamCommunity;
  readonly events: Stream.Stream<SteamEvent, never>;
  readonly steamID: Effect.Effect<NonNullable<SteamUser['steamID']> | null>;
  readonly logOn: (details: Parameters<SteamUser['logOn']>[0]) => Effect.Effect<void, SteamError | Cause.TimeoutException>;
  readonly logOff: Effect.Effect<void>;
  readonly setPersona: (state: SteamUser.EPersonaState) => Effect.Effect<void>;
  readonly gamesPlayed: (appIds: ReadonlyArray<number>) => Effect.Effect<void>;
  readonly getCommunityUser: (id: NonNullable<SteamUser['steamID']>) => Effect.Effect<CSteamUser | null>;
  readonly getUserOwnedApps: (
    id: NonNullable<SteamUser['steamID']>,
    options: SteamUser.GetUserOwnedAppsOptions,
  ) => Effect.Effect<SteamUser.UserOwnedApps, SteamError | Cause.TimeoutException>;
  readonly getProductInfo: (
    apps: ReadonlyArray<number>,
    packages: ReadonlyArray<number>,
  ) => Effect.Effect<SteamUser.ProductInfo, SteamError | Cause.TimeoutException>;
  readonly requestFreeLicense: (appIDs: ReadonlyArray<number>) => Effect.Effect<void, SteamError | Cause.TimeoutException>;
  readonly updatePersonaAndGames: (state: SteamUser.EPersonaState, appIds: ReadonlyArray<number>) => Effect.Effect<void>;
}

const createEventStream = (user: SteamUser, community: SteamCommunity): Stream.Stream<SteamEvent, never> =>
  Stream.async<SteamEvent>((emit) => {
    const onWebSession = (_sessionID: string, cookies: string[]) => community.setCookies(cookies);
    const onLoggedOn = () => emit.single({ _tag: 'LoggedOn' });
    const onError = (error: Error & { readonly eresult?: number }) => emit.single({ _tag: 'Error', error });
    const onRefreshToken = (token: string) => emit.single({ _tag: 'RefreshToken', token });
    const onSteamGuard = (domain: string | null, callback: (code: string) => void, lastCodeWrong: boolean) =>
      emit.single({ _tag: 'SteamGuard', domain, callback, lastCodeWrong });
    const onUser = (steamId: NonNullable<SteamUser['steamID']>, user: Record<string, unknown>) =>
      emit.single({
        _tag: 'User',
        steamId,
        user: {
          persona_state: (user?.persona_state as number | undefined) ?? null,
          player_name: (user?.player_name as string | undefined) ?? null,
        },
      });
    const onVacBans = (numBans: number, appids: number[]) => emit.single({ _tag: 'VacBans', numBans, appids });

    user.on('webSession', onWebSession);
    user.on('loggedOn', onLoggedOn);
    user.on('error', onError);
    user.on('refreshToken', onRefreshToken);
    user.on('steamGuard', onSteamGuard);
    user.on('user', onUser);
    user.on('vacBans', onVacBans);

    return Effect.sync(() => {
      user.once('error', () => {});
      user.removeListener('webSession', onWebSession);
      user.removeListener('loggedOn', onLoggedOn);
      user.removeListener('error', onError);
      user.removeListener('refreshToken', onRefreshToken);
      user.removeListener('steamGuard', onSteamGuard);
      user.removeListener('user', onUser);
      user.removeListener('vacBans', onVacBans);
    });
  }).pipe(
    Stream.tap((event) => Effect.logTrace(`Steam Event: ${event._tag}`, event)),
    Stream.tapError((error) => Effect.logError('Steam event stream error', error)),
  );

const createSteamClient = (dataDirectory: string): Effect.Effect<SteamClient, never, Scope.Scope> =>
  Effect.gen(function* () {
    const user = new SteamUser({
      dataDirectory,
      renewRefreshTokens: true,
      autoRelogin: false,
    });
    const community = new SteamCommunity({
      timeout: 10_000,
    });

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
          const err = error as Error & { readonly eresult?: number };
          return isSteamErrorTimeout(err)
            ? new Cause.TimeoutException()
            : new SteamError({
                message: err.message,
                eresult: err.eresult,
                cause: error,
              });
        },
      }).pipe(Effect.timeout(timeout), Effect.retry(RetryTimeoutPolicy));

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

          const onError = (error: Error & { readonly eresult?: number }) => {
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
      gamesPlayed: (appIds) => Effect.sync(() => user.gamesPlayed([...appIds])),
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
      getProductInfo: (apps, packages) => wrapPromise(() => user.getProductInfo([...apps], [...packages])),
      requestFreeLicense: (appIDs) => wrapPromise(() => user.requestFreeLicense([...appIDs])),
      updatePersonaAndGames: (state, appIds) =>
        Effect.sync(() => {
          user.setPersona(state);
          user.gamesPlayed([...appIds]);
        }),
    } satisfies SteamClient;
  });

export class SteamClientTag extends Context.Tag('@services/SteamClient')<SteamClientTag, SteamClient>() {}

export const SteamClientLayer = (dataDirectory: string): Layer.Layer<SteamClientTag> =>
  Layer.scoped(SteamClientTag, createSteamClient(dataDirectory));
