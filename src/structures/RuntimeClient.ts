import { chalk } from '@vegapunk/utilities';
import { isErrorLike } from '@vegapunk/utilities/result';
import { Cause, Chunk, Data, Effect, Fiber, Ref, Runtime, Schedule } from 'effect';

export class RuntimeRestart extends Data.TaggedError('RuntimeRestart') {}

export interface RuntimeBridge {
  readonly runFork: <A, E, R>(effect: Effect.Effect<A, E, R>, options?: { readonly name?: string }) => Fiber.RuntimeFiber<A | void, never>;
  readonly runSync: <A, E, R>(effect: Effect.Effect<A, E, R>) => A;
  readonly runPromise: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>;
}

export const makeRuntimeBridge = Effect.gen(function* () {
  const runtime = yield* Effect.runtime<unknown>();
  const runFork = Runtime.runFork(runtime);
  const runSync = Runtime.runSync(runtime);
  const runPromise = Runtime.runPromise(runtime);

  return {
    runFork: (effect, options) =>
      runFork(
        effect.pipe(
          Effect.catchAllCause((cause) =>
            Effect.logError(chalk`{bold.red Unhandled error in forked bridge${options?.name ? ` [${options.name}]` : ''}}`, cause),
          ),
        ),
      ),
    runSync: (effect) => runSync(effect),
    runPromise: (effect) => runPromise(effect),
  } as RuntimeBridge;
});

export interface RuntimeCycleOptions {
  readonly maxRestarts?: number;
  readonly intervalMs?: number;
  readonly restartDelayMs?: number;
}

export const cycleUntilMidnight = <A, E, R>(flow: Effect.Effect<A, E, R> = Effect.never): Effect.Effect<A, E | RuntimeRestart, R> =>
  Effect.gen(function* () {
    const msUntilMidnight = yield* Effect.sync(() => {
      const now = new Date();
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
      return tomorrow.getTime() - now.getTime();
    });

    const midnightTask = Effect.gen(function* () {
      yield* Effect.sleep(`${msUntilMidnight} millis`);
      yield* Effect.logInfo(chalk`{bold.yellow It's midnight time. Restarting system...}`);
    });

    const result = yield* Effect.race(
      Effect.map(flow, (value) => ({ _tag: 'flow' as const, value })),
      Effect.as(midnightTask, { _tag: 'midnight' as const }),
    );

    if (result._tag === 'midnight') {
      return yield* new RuntimeRestart();
    }

    return result.value;
  });

export const runMainCycle = <A, E, R>(program: Effect.Effect<A, E, R>, options: RuntimeCycleOptions = {}): void => {
  const { maxRestarts = 3, intervalMs = 60_000, restartDelayMs = 5_000 } = options;

  const isRuntimeRestart = (error: unknown): error is RuntimeRestart => {
    return (
      (isErrorLike<{ readonly _tag: string }>(error) && error._tag === 'RuntimeRestart') ||
      error instanceof RuntimeRestart ||
      (typeof error === 'object' && error !== null && '_tag' in error && error._tag === 'RuntimeRestart')
    );
  };

  const mainEffect = Effect.gen(function* () {
    const restartTimesRef = yield* Ref.make<readonly number[]>([]);

    const loop = Effect.repeat(
      program.pipe(
        Effect.scoped,
        Effect.catchAllCause((cause) => {
          if (Chunk.some(Cause.failures(cause), isRuntimeRestart)) {
            return Effect.void;
          }

          return Effect.gen(function* () {
            const now = Date.now();
            const restartTimes = yield* Ref.get(restartTimesRef);
            const nextRestarts = [...restartTimes.filter((t) => now - t < intervalMs), now];

            yield* Ref.set(restartTimesRef, nextRestarts);

            if (nextRestarts.length >= maxRestarts) {
              yield* Effect.logFatal(chalk`{bold.red System crashed too many times. Shutting down...}`, cause);
              yield* Effect.promise(() => process.exit(1));
              return;
            }

            yield* Effect.logError(chalk`{bold.red System encountered an error}`, cause);
            yield* Effect.logInfo(chalk`{bold.yellow System restarting in ${restartDelayMs / 1000} seconds...}`);
            yield* Effect.sleep(`${restartDelayMs} millis`);
          });
        }),
      ),
      Schedule.forever,
    );

    const { runFork, runPromise } = yield* makeRuntimeBridge;

    const fiber = runFork(loop);

    const cleanUp = () => {
      runPromise(Fiber.interrupt(fiber))
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    };

    process.once('SIGINT', () => cleanUp());
    process.once('SIGTERM', () => cleanUp());

    yield* Fiber.await(fiber);
  });

  Effect.runFork(mainEffect as Effect.Effect<never, never, never>);
};
