import { Data, Effect, Schedule } from 'effect';

import { isErrorTimeout } from '../structures/HttpClient';

export interface SteamErrorBase {
  readonly message: string;
  readonly eresult?: number;
  readonly cause?: unknown;
}

export class FreeGameError extends Data.TaggedError('FreeGameError')<SteamErrorBase> {}
export class SteamError extends Data.TaggedError('SteamError')<SteamErrorBase> {}
export class AuthError extends Data.TaggedError('AuthError')<SteamErrorBase> {}

export const RetryTimeoutPolicy = Effect.retry(Schedule.recurs(3).pipe(Schedule.whileInput(isErrorTimeout)));

export const catchAndLogUnlessTimeout =
  <B>(prefix: string, defaultValue: B) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.catchAll(effect, (error) =>
      isErrorTimeout(error)
        ? Effect.succeed(defaultValue)
        : Effect.logError(error instanceof Error ? error.message : String(error), { cause: error }).pipe(
            Effect.annotateLogs('context', prefix),
            Effect.as(defaultValue),
          ),
    );
