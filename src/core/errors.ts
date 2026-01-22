import { Data, Effect, Schedule } from 'effect';

import { isErrorTimeout } from '../structures/HttpClient';

export interface SteamBaseError {
  readonly message: string;
  readonly eresult?: number;
  readonly cause?: unknown;
}

export class FreeGameError extends Data.TaggedError('FreeGameError')<SteamBaseError> {}

export class SteamError extends Data.TaggedError('SteamError')<SteamBaseError> {}

export class AuthError extends Data.TaggedError('AuthError')<SteamBaseError> {}

export const RetryTimeoutPolicy = Effect.retry(Schedule.recurs(3).pipe(Schedule.whileInput(isErrorTimeout)));

export const catchAndLogUnlessTimeout =
  <B>(prefix: string, defaultValue: B) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | B, never, R> =>
    Effect.catchAll(effect, (error) => {
      if (isErrorTimeout(error)) {
        return Effect.succeed(defaultValue);
      }

      const message = error instanceof Error ? error.message : String(error);

      return Effect.logError(message, { cause: error }).pipe(Effect.annotateLogs('context', prefix), Effect.as(defaultValue));
    });
