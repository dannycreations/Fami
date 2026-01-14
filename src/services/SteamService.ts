import { Cause, Context, Duration, Effect, Layer, Stream } from 'effect';
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
    const onWebSession = (_sessionID: string, cookies: string[]) => community.setCookies(cookies);
    const onLoggedOn = () => emit.single({ type: 'loggedOn' });
    const onError = (error: Error & { eresult?: number }) => emit.single({ type: 'error', error });
    const onRefreshToken = (token: string) => emit.single({ type: 'refreshToken', token });
    const onSteamGuard = (domain: string | null, callback: (code: string) => void, lastCodeWrong: boolean) =>
      emit.single({ type: 'steamGuard', domain, callback, lastCodeWrong });
    const onUser = (steamId: NonNullable<SteamUser['steamID']>, user: Record<string, any>) =>
      emit.single({
        type: 'user',
        steamId,
        user: {
          persona_state: (user?.persona_state as number | undefined) ?? null,
          player_name: (user?.player_name as string | undefined) ?? null,
        },
      });
    const onVacBans = (numBans: number, appids: number[]) => emit.single({ type: 'vacBans', numBans, appids });

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
    Stream.tap((event) => Effect.annotateLogs(Effect.logTrace(`Steam Event: ${event.type}`), 'event', JSON.stringify(event))),
    Stream.tapError((error) => Effect.logError('Steam event stream error', error)),
  );

const createSteamClient = (dataDirectory: string) =>
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

    const wrapPromise = <A>(promise: () => Promise<A>, timeout: Duration.DurationInput = '30 seconds') =>
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
      logOn: (details: Parameters<SteamUser['logOn']>[0]) =>
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
      setPersona: (state: SteamUser.EPersonaState) => Effect.sync(() => user.setPersona(state)),
      gamesPlayed: (appIds: number[]) => Effect.sync(() => user.gamesPlayed(appIds)),
      getCommunityUser: (id: NonNullable<SteamUser['steamID']>) =>
        Effect.async<CSteamUser | null>((resume) => {
          community.getSteamUser(id, (error, user) => {
            resume(Effect.succeed(error ? null : user));
          });
        }).pipe(
          Effect.timeout('10 seconds'),
          Effect.catchTag('TimeoutException', () => Effect.succeed(null)),
        ),
      getUserOwnedApps: (steamID: NonNullable<SteamUser['steamID']>, options: SteamUser.GetUserOwnedAppsOptions) =>
        wrapPromise(() => user.getUserOwnedApps(steamID, options), '1 minute'),
      getProductInfo: (apps: number[], packages: number[]) => wrapPromise(() => user.getProductInfo(apps, packages)),
      requestFreeLicense: (appIDs: number[]) => wrapPromise(() => user.requestFreeLicense(appIDs)),
      updatePersonaAndGames: (state: SteamUser.EPersonaState, appIds: number[]) =>
        Effect.sync(() => {
          user.setPersona(state);
          user.gamesPlayed(appIds);
        }),
    };
  });

export class SteamClientTag extends Context.Tag('@services/SteamLayer')<SteamClientTag, SteamClient>() {}

export const SteamClientLayer = (dataDirectory: string) => Layer.scoped(SteamClientTag, createSteamClient(dataDirectory));
