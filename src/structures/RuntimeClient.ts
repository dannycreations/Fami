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

export const cycleUntilMidnight: Effect.Effect<never, RuntimeRestart> = Effect.gen(function* () {
  const msUntilMidnight = yield* Effect.sync(() => {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    return tomorrow.getTime() - now.getTime();
  });

  yield* Effect.sleep(`${msUntilMidnight} millis`);
  yield* Effect.logInfo(chalk`{bold.yellow It's midnight time. Restarting app...}`);
  return yield* Effect.fail(new RuntimeRestart());
});

export const runMainCycle = <A, E, R>(program: Effect.Effect<A, E, R>, options: RuntimeCycleOptions = {}): void => {
  const { maxRestarts = 3, intervalMs = 60_000, restartDelayMs = 5_000 } = options;

  const mainEffect = Effect.gen(function* () {
    const { runFork, runPromise } = yield* makeRuntimeBridge;

    const restartTimesRef = yield* Ref.make<readonly number[]>([]);

    const cycle = program.pipe(
      Effect.scoped,
      Effect.catchAllCause((cause) =>
        Effect.gen(function* () {
          const failures = Cause.failures(cause);

          const isRestart = (error: unknown) => isErrorLike<{ readonly _tag: string }>(error) && error._tag === 'RuntimeRestart';
          if (Chunk.some(failures, isRestart)) {
            return;
          }

          const now = yield* Effect.sync(() => Date.now());
          const restartTimes = yield* Ref.get(restartTimesRef);
          const nextRestarts = [...restartTimes.filter((t) => now - t < intervalMs), now];

          yield* Ref.set(restartTimesRef, nextRestarts);

          if (nextRestarts.length >= maxRestarts) {
            yield* Effect.logFatal(chalk`{bold.red System crashed too many times. Shutting down...}`, cause);
            yield* Effect.sync(() => process.exit(1));
          }

          yield* Effect.logError(chalk`{bold.red System encountered an error}`, cause);
          yield* Effect.logInfo(chalk`{bold.yellow System restarting in ${restartDelayMs / 1000} seconds...}`);
          yield* Effect.sleep(`${restartDelayMs} millis`);
        }),
      ),
      Effect.repeat(Schedule.forever),
      Effect.ignore,
    );

    const fiber = runFork(cycle);

    const cleanUp = () => {
      runPromise(Fiber.interrupt(fiber))
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    };

    process.on('SIGINT', cleanUp);
    process.on('SIGTERM', cleanUp);
  });

  Effect.runFork(mainEffect as Effect.Effect<never, never, never>);
};
