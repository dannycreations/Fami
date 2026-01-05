import { Data } from 'effect';

export class FreeGameError extends Data.TaggedError('FreeGameError')<{
  readonly message: string;
  readonly originalError?: unknown;
}> {}

export class SteamError extends Data.TaggedError('SteamError')<{
  readonly message: string;
  readonly originalError?: unknown;
  readonly eresult?: number;
}> {}

export class StoreError extends Data.TaggedError('StoreError')<{
  readonly message: string;
  readonly originalError?: unknown;
}> {}
