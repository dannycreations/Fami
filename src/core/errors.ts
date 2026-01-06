import { Data } from 'effect';

export interface BaseErrorInfo {
  readonly message: string;
  readonly originalError?: unknown;
}

export class FreeGameError extends Data.TaggedError('FreeGameError')<BaseErrorInfo> {}

export class SteamError extends Data.TaggedError('SteamError')<BaseErrorInfo & { readonly eresult?: number }> {}

export class StoreError extends Data.TaggedError('StoreError')<BaseErrorInfo> {}
