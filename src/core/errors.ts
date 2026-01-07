import { Data, Effect, Schedule } from 'effect';

import { isErrorTimeout } from '../services/HttpService';

export interface SteamErrorBase {
  readonly message: string;
  readonly eresult?: number;
  readonly steam?: unknown;
}

export class FreeGameError extends Data.TaggedError('FreeGameError')<SteamErrorBase> {}
export class SteamError extends Data.TaggedError('SteamError')<SteamErrorBase> {}
export class AuthError extends Data.TaggedError('AuthError')<SteamErrorBase> {}

export const RetryTimeoutPolicy = Effect.retry(Schedule.recurs(3).pipe(Schedule.whileInput(isErrorTimeout)));

export const catchAndLogUnlessTimeout =
  <B>(prefix: string, defaultValue: B) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | B, never, R> =>
    Effect.catchAll(effect, (error) => {
      if (isErrorTimeout(error)) return Effect.succeed(defaultValue);

      const message = error instanceof Error ? error.message : String(error);
      return Effect.logError(message, error).pipe(Effect.annotateLogs('context', prefix), Effect.as(defaultValue));
    });
