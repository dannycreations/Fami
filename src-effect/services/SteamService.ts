import { Context, Effect, Layer, Scope, Stream } from 'effect';
import SteamUser from 'steam-user';
import SteamCommunity from 'steamcommunity';
import CSteamUser from 'steamcommunity/classes/CSteamUser';

import { UserStatus } from '../schemas/Domain';

export class SteamError extends Error {
  readonly _tag = 'SteamError';
  readonly eresult?: SteamUser.EResult;

  constructor(
    override readonly message: string,
    readonly originalError?: unknown,
  ) {
    super(message);
    if (originalError && typeof originalError === 'object' && 'eresult' in originalError) {
      this.eresult = (originalError as { eresult: number }).eresult;
    }
  }
}

export type SteamEvent =
  | { type: 'loggedOn' }
  | { type: 'webSession'; sessionID: string; cookies: string[] }
  | { type: 'error'; error: Error & { eresult: number } }
  | { type: 'refreshToken'; token: string }
  | { type: 'steamGuard'; domain: string | null; callback: (code: string) => void; lastCodeWrong: boolean }
  | { type: 'user'; sid: NonNullable<SteamUser['steamID']>; user: UserStatus }
  | { type: 'vacBans'; numBans: number; appids: number[] };

export interface SteamClient {
  readonly user: SteamUser;
  readonly community: SteamCommunity;
  readonly events: Stream.Stream<SteamEvent, never>;
  readonly steamID: Effect.Effect<NonNullable<SteamUser['steamID']> | null>;
  readonly logOn: (details: Parameters<SteamUser['logOn']>[0]) => Effect.Effect<void, SteamError>;
  readonly waitForLogOn: Effect.Effect<void, SteamError>;
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

    const eventStream = Stream.async<SteamEvent>((emit) => {
      user.on('webSession', (sessionID, cookies) => {
        community.setCookies(cookies);
        emit.single({ type: 'webSession', sessionID, cookies });
      });
      user.on('loggedOn', () => {
        emit.single({ type: 'loggedOn' });
      });
      user.on('error', (error) => {
        emit.single({ type: 'error', error });
      });
      user.on('refreshToken', (token) => {
        emit.single({ type: 'refreshToken', token });
      });
      user.on('steamGuard', (domain, callback, lastCodeWrong) => {
        emit.single({ type: 'steamGuard', domain, callback, lastCodeWrong });
      });
      user.on('user', (sid, user) => {
        emit.single({ type: 'user', sid, user: user as unknown as UserStatus });
      });
      user.on('vacBans', (numBans, appids) => {
        emit.single({ type: 'vacBans', numBans, appids });
      });
    }).pipe(
      Stream.tap((event) => Effect.annotateLogs(Effect.logTrace(`Steam Event: ${event.type}`), 'event', JSON.stringify(event))),
      Stream.tapError((e) => Effect.logError('Steam event stream error', e)),
    );

    return {
      user,
      community,
      events: eventStream,
      steamID: Effect.sync(() => user.steamID),
      logOn: (details) => Effect.sync(() => user.logOn(details)),
      waitForLogOn: Effect.async<void, SteamError>((resume) => {
        const onLoggedOn = () => {
          user.removeListener('error', onError);
          resume(Effect.void);
        };
        const onError = (err: Error) => {
          user.removeListener('loggedOn', onLoggedOn);
          resume(Effect.fail(new SteamError(err.message || 'Login failed', err)));
        };
        user.once('loggedOn', onLoggedOn);
        user.once('error', onError);

        return Effect.sync(() => {
          user.removeListener('loggedOn', onLoggedOn);
          user.removeListener('error', onError);
        });
      }),
      logOff: Effect.sync(() => user.logOff()),
      setPersona: (state) => Effect.sync(() => user.setPersona(state)),
      gamesPlayed: (appIds) => Effect.sync(() => user.gamesPlayed(appIds)),
      getCommunityUser: (id) =>
        Effect.async<CSteamUser | null>((resume) => {
          const timeoutId = setTimeout(() => resume(Effect.succeed(null)), 10_000);
          community.getSteamUser(id, (err, user) => {
            clearTimeout(timeoutId);
            if (err) {
              resume(Effect.succeed(null));
            } else {
              resume(Effect.succeed(user));
            }
          });
        }),
      getUserOwnedApps: (steamID, options) =>
        Effect.async<SteamUser.UserOwnedApps, SteamError>((resume) => {
          const timeoutId = setTimeout(() => resume(Effect.fail(new SteamError('Request timed out'))), 60_000);
          user
            .getUserOwnedApps(steamID, options)
            .then((res) => {
              clearTimeout(timeoutId);
              resume(Effect.succeed(res));
            })
            .catch((err) => {
              clearTimeout(timeoutId);
              resume(Effect.fail(new SteamError(err.message || 'Failed to get user owned apps', err)));
            });
        }),
      getProductInfo: (apps, packages) =>
        Effect.tryPromise({
          try: () => user.getProductInfo(apps, packages),
          catch: (error) => new SteamError('Failed to get product info', error),
        }),
      requestFreeLicense: (appIDs) =>
        Effect.tryPromise({
          try: () => user.requestFreeLicense(appIDs),
          catch: (error) => new SteamError('Failed to request free license', error),
        }),
    };
  });
};

export const SteamClientLive = (dataDirectory: string) => Layer.scoped(SteamClient, makeSteamClient(dataDirectory));
