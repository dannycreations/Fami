import { chalk } from '@vegapunk/utilities';
import { isErrorLike } from '@vegapunk/utilities/result';
import { Cause, Data, Effect, Fiber, Schedule } from 'effect';

export class ScheduleRestart extends Data.TaggedError('ScheduleRestart') {}

export interface RuntimeOptions {
  readonly maxRestarts?: number;
  readonly intervalMs?: number;
  readonly restartDelayMs?: number;
}

export const runForkWithCleanUp = <A, E, R>(effect: Effect.Effect<A, E, R>): void => {
  const fiber = Effect.runFork(effect as Effect.Effect<A, E>);
  process.on('SIGINT', () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => process.exit(0)));
  process.on('SIGTERM', () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => process.exit(0)));
};

export const skdWithRestart = <A, E, R>(program: Effect.Effect<A, E, R>, options: RuntimeOptions = {}): Effect.Effect<void, never, R> => {
  const { maxRestarts = 3, intervalMs = 60_000, restartDelayMs = 5_000 } = options;
  const restartTimes: number[] = [];

  const loop = Effect.gen(function* (_) {
    yield* _(
      Effect.catchAllCause(program, (cause) =>
        Effect.gen(function* (_) {
          // Check if failure is a requested restart to avoid counting it as a crash
          const isRestart = Array.from(Cause.failures(cause)).some(
            (error) => isErrorLike<{ _tag: string }>(error) && error._tag === 'ScheduleRestart',
          );

          if (isRestart) {
            yield* _(Effect.logInfo(chalk`{bold.yellow Scheduled restart triggered.}`));
            return;
          }

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

  return Effect.repeat(loop, Schedule.forever).pipe(Effect.asVoid);
};

export const skdMidnightRestart = Effect.gen(function* (_) {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const msUntilMidnight = tomorrow.getTime() - now.getTime();

  yield* _(Effect.sleep(`${msUntilMidnight} millis`));
  yield* _(Effect.logInfo(chalk`{bold.yellow It's midnight time. Restarting app...}`));
  return yield* _(Effect.fail(new ScheduleRestart()));
});
