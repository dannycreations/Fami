import { Data, Effect } from 'effect';

import { TIMEOUT_MESSAGE } from './constants';

export interface BaseErrorInfo {
  readonly message: string;
  readonly originalError?: unknown;
}

export class FreeGameError extends Data.TaggedError('FreeGameError')<BaseErrorInfo> {}

export class SteamError extends Data.TaggedError('SteamError')<BaseErrorInfo & { readonly eresult?: number }> {}

export class StoreError extends Data.TaggedError('StoreError')<BaseErrorInfo> {}

export class AuthError extends Data.TaggedError('AuthError')<BaseErrorInfo> {}

export const catchAndLogUnlessTimeout =
  <A, E, R, B>(prefix: string, defaultValue: B) =>
  (effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchAll((error) => {
        const message = error instanceof Error ? error.message : String(error);
        return (message !== TIMEOUT_MESSAGE ? Effect.logError(`${prefix}: ${message}`, error) : Effect.void).pipe(Effect.as(defaultValue));
      }),
    );
