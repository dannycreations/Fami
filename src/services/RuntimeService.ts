import { chalk } from '@vegapunk/utilities';
import { Data, Effect, Schedule } from 'effect';

class RestartRequested extends Data.TaggedError('RestartRequested') {}

export interface RuntimeOptions {
  readonly maxRestarts?: number;
  readonly intervalMs?: number;
  readonly restartDelayMs?: number;
}

export const runWithRestart = <A, E, R>(program: Effect.Effect<A, E, R>, options: RuntimeOptions = {}) => {
  const { maxRestarts = 3, intervalMs = 60_000, restartDelayMs = 5_000 } = options;
  const restartTimes: number[] = [];

  const loop: Effect.Effect<void, never, R> = Effect.gen(function* (_) {
    yield* _(
      program,
      Effect.catchAllCause((cause) =>
        Effect.gen(function* (_) {
          const now = Date.now();
          restartTimes.push(now);

          const recentRestarts = restartTimes.filter((t) => now - t < intervalMs);
          restartTimes.length = 0;
          restartTimes.push(...recentRestarts);

          if (restartTimes.length >= maxRestarts) {
            yield* _(Effect.logFatal(chalk`{bold.red System crashed too many times (${maxRestarts}+ in ${intervalMs / 1000}s). Shutting down...}`));
            yield* _(Effect.logError(cause));
            process.exit(1);
          }

          yield* _(Effect.logError(chalk`{bold.red System encountered an error:}`, cause));
          yield* _(Effect.logInfo(chalk`{bold.yellow System restarting in ${restartDelayMs / 1000} seconds...}`, cause));
          yield* _(Effect.sleep(`${restartDelayMs} millis`));
        }),
      ),
    );
  });

  return Effect.repeat(loop, Schedule.forever);
};

export const runMidnightRestart = Effect.gen(function* (_) {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const msUntilMidnight = tomorrow.getTime() - now.getTime();

  yield* _(Effect.sleep(`${msUntilMidnight} millis`));
  yield* _(Effect.logInfo(chalk`{bold.yellow It's midnight time. Restarting app...}`));
  return yield* _(Effect.fail(new RestartRequested()));
});
