import { Data, Effect } from 'effect';

import { TIMEOUT_MESSAGE } from './constants';

export interface BaseErrorInfo {
  readonly message: string;
  readonly originalError?: unknown;
}

export class FreeGameError extends Data.TaggedError('FreeGameError')<BaseErrorInfo> {}

export class SteamError extends Data.TaggedError('SteamError')<BaseErrorInfo & { readonly eresult?: number }> {}

export class AuthError extends Data.TaggedError('AuthError')<BaseErrorInfo> {}

export const catchAndLogUnlessTimeout =
  <B>(prefix: string, defaultValue: B) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | B, never, R> =>
    Effect.catchAll(effect, (error) => {
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout =
        message === TIMEOUT_MESSAGE || (typeof error === 'object' && error !== null && '_tag' in error && error._tag === 'TimeoutException');

      if (isTimeout) {
        return Effect.succeed(defaultValue);
      }

      return Effect.logError(message, error).pipe(Effect.annotateLogs('context', prefix), Effect.as(defaultValue));
    });
