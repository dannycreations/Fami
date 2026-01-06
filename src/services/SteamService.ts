import { Context, Effect, Layer, Schedule, Scope, Stream } from 'effect';
import SteamUser from 'steam-user';
import SteamCommunity from 'steamcommunity';
import CSteamUser from 'steamcommunity/classes/CSteamUser';

import { TIMEOUT_MESSAGE } from '../core/constants';
import { SteamError } from '../core/errors';
import { UserStatus } from '../core/schemas';

export type SteamEvent =
  | { readonly type: 'loggedOn' }
  | { readonly type: 'error'; readonly error: Error & { eresult?: number } }
  | { readonly type: 'refreshToken'; readonly token: string }
  | {
      readonly type: 'steamGuard';
      readonly domain: string | null;
      readonly callback: (code: string) => void;
      readonly lastCodeWrong: boolean;
    }
  | { readonly type: 'user'; readonly sid: NonNullable<SteamUser['steamID']>; readonly user: UserStatus }
  | { readonly type: 'vacBans'; readonly numBans: number; readonly appids: number[] };

export const SteamRetryPolicy = Schedule.recurs(3).pipe(Schedule.whileInput((error: Error) => error.message === TIMEOUT_MESSAGE));

export interface SteamClient {
  readonly user: SteamUser;
  readonly community: SteamCommunity;
  readonly events: Stream.Stream<SteamEvent, never>;
  readonly steamID: Effect.Effect<NonNullable<SteamUser['steamID']> | null>;
  readonly logOn: (details: Parameters<SteamUser['logOn']>[0]) => Effect.Effect<void, SteamError>;
  readonly logOff: Effect.Effect<void>;
  readonly setPersona: (state: SteamUser.EPersonaState) => Effect.Effect<void>;
  readonly gamesPlayed: (appIds: number[]) => Effect.Effect<void>;
  readonly getCommunityUser: (id: NonNullable<SteamUser['steamID']>) => Effect.Effect<CSteamUser | null>;
  readonly getUserOwnedApps: (
    id: NonNullable<SteamUser['steamID']>,
    options: SteamUser.GetUserOwnedAppsOptions,
  ) => Effect.Effect<SteamUser.UserOwnedApps, SteamError>;
  readonly getProductInfo: (apps: number[], packages: number[]) => Effect.Effect<SteamUser.ProductInfo, SteamError>;
  readonly requestFreeLicense: (appIDs: number[]) => Effect.Effect<void, SteamError>;
}

export const SteamClient = Context.GenericTag<SteamClient>('@services/SteamClient');

const createEventStream = (user: SteamUser, community: SteamCommunity) =>
  Stream.async<SteamEvent>((emit) => {
    const onWebSession = (_sessionID: string, cookies: string[]) => {
      community.setCookies(cookies);
    };
    const onLoggedOn = () => {
      emit.single({ type: 'loggedOn' });
    };
    const onError = (error: Error & { eresult?: number }) => {
      emit.single({ type: 'error', error });
    };
    const onRefreshToken = (token: string) => {
      emit.single({ type: 'refreshToken', token });
    };
    const onSteamGuard = (domain: string | null, callback: (code: string) => void, lastCodeWrong: boolean) => {
      emit.single({ type: 'steamGuard', domain, callback, lastCodeWrong });
    };
    const onUser = (sid: NonNullable<SteamUser['steamID']>, user: unknown) => {
      emit.single({ type: 'user', sid, user: user as unknown as UserStatus });
    };
    const onVacBans = (numBans: number, appids: number[]) => {
      emit.single({ type: 'vacBans', numBans, appids });
    };

    user.on('webSession', onWebSession);
    user.on('loggedOn', onLoggedOn);
    user.on('error', onError);
    user.on('refreshToken', onRefreshToken);
    user.on('steamGuard', onSteamGuard);
    user.on('user', onUser);
    user.on('vacBans', onVacBans);

    return Effect.sync(() => {
      // Suppress late errors
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
    Stream.tap((event) => Effect.annotateLogs(Effect.logTrace(`Steam Event: ${event.type}`), 'event', JSON.stringify(event))),
    Stream.tapError((error) => Effect.logError('Steam event stream error', error)),
  );

export const makeSteamClient = (dataDirectory: string): Effect.Effect<SteamClient, never, Scope.Scope> => {
  return Effect.gen(function* (_) {
    const user = new SteamUser({ dataDirectory, renewRefreshTokens: true, autoRelogin: false });
    const community = new SteamCommunity({ timeout: 10_000 });

    yield* _(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          user.logOff();
          user.removeAllListeners();
          community.removeAllListeners();
        }),
      ),
    );

    return {
      user,
      community,
      events: createEventStream(user, community),
      steamID: Effect.sync(() => user.steamID),
      logOn: (details) =>
        Effect.async<void, SteamError>((resume) => {
          const onLoggedOn = () => {
            user.removeListener('error', onError);
            resume(Effect.void);
          };
          const onError = (error: Error & { eresult?: number }) => {
            user.removeListener('loggedOn', onLoggedOn);
            resume(
              Effect.fail(
                new SteamError({
                  message: error.message || 'Login failed',
                  originalError: error,
                  eresult: error.eresult,
                }),
              ),
            );
          };

          user.once('loggedOn', onLoggedOn);
          user.once('error', onError);
          user.logOn(details);

          return Effect.sync(() => {
            user.removeListener('loggedOn', onLoggedOn);
            user.removeListener('error', onError);
          });
        }).pipe(
          Effect.timeout('60 seconds'),
          Effect.catchTag('TimeoutException', () => Effect.fail(new SteamError({ message: 'Login timed out' }))),
        ),
      logOff: Effect.sync(() => user.logOff()),
      setPersona: (state) => Effect.sync(() => user.setPersona(state)),
      gamesPlayed: (appIds) => Effect.sync(() => user.gamesPlayed(appIds)),
      getCommunityUser: (id) =>
        Effect.async<CSteamUser | null>((resume) => {
          community.getSteamUser(id, (error, user) => {
            if (error) {
              resume(Effect.succeed(null));
            } else {
              resume(Effect.succeed(user));
            }
          });
        }).pipe(
          Effect.timeout('10 seconds'),
          Effect.catchTag('TimeoutException', () => Effect.succeed(null)),
        ),
      getUserOwnedApps: (steamID, options) =>
        Effect.tryPromise({
          try: () => user.getUserOwnedApps(steamID, options),
          catch: (error) => {
            const err = error as Error & { eresult?: number };
            return new SteamError({
              message: err.message || 'Failed to get user owned apps',
              originalError: error,
              eresult: err.eresult,
            });
          },
        }).pipe(
          Effect.timeout('1 minute'),
          Effect.catchTag('TimeoutException', () => Effect.fail(new SteamError({ message: TIMEOUT_MESSAGE }))),
        ),
      getProductInfo: (apps, packages) =>
        Effect.tryPromise({
          try: () => user.getProductInfo(apps, packages),
          catch: (error) => {
            const err = error as Error & { eresult?: number };
            return new SteamError({
              message: 'Failed to get product info',
              originalError: error,
              eresult: err?.eresult,
            });
          },
        }),
      requestFreeLicense: (appIDs) =>
        Effect.tryPromise({
          try: () => user.requestFreeLicense(appIDs),
          catch: (error) => {
            const err = error as Error & { eresult?: number };
            return new SteamError({
              message: 'Failed to request free license',
              originalError: error,
              eresult: err?.eresult,
            });
          },
        }).pipe(
          Effect.timeout('30 seconds'),
          Effect.catchTag('TimeoutException', () => Effect.fail(new SteamError({ message: 'Request free license timed out' }))),
        ),
    };
  });
};

export const SteamClientLive = (dataDirectory: string) => Layer.scoped(SteamClient, makeSteamClient(dataDirectory));
