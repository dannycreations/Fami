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

export const RetryTimeoutPolicy = Effect.retry(
  Schedule.recurs(3).pipe(
    Schedule.whileInput((error) => isErrorTimeout(error) || (error instanceof SteamError && error.message.toLowerCase().includes('timed out'))),
  ),
);

export const catchAndLogUnlessTimeout =
  <B>(prefix: string, defaultValue: B) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | B, never, R> =>
    Effect.catchAll(effect, (cause) => {
      if (isErrorTimeout(cause)) {
        return Effect.succeed(defaultValue);
      }

      const message = cause instanceof Error ? cause.message : String(cause);

      return Effect.logError(message, { prefix, cause }).pipe(Effect.as(defaultValue));
    });
