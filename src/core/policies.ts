import { Effect, Schedule } from 'effect';

import { TIMEOUT_MESSAGE } from './constants';

export const RetryPolicy = Effect.retry(
  Schedule.recurs(3).pipe(
    Schedule.whileInput((error: any) => {
      const message = error instanceof Error ? error.message : String(error);
      return (
        message === TIMEOUT_MESSAGE ||
        (typeof error === 'object' && error !== null && (error._tag === 'TimeoutException' || error.code === 'ETIMEDOUT'))
      );
    }),
  ),
);
