import { chalk } from '@vegapunk/utilities';
import { isErrorLike } from '@vegapunk/utilities/result';
import { Cause, Chunk, Data, Effect, Fiber, Layer, Ref, Runtime, Schedule, Scope } from 'effect';

export class RuntimeRestart extends Data.TaggedError('RuntimeRestart') {}

export interface Bridge {
  readonly fork: <A, E, R>(effect: Effect.Effect<A, E, R>, options?: { readonly name?: string }) => Fiber.RuntimeFiber<A | void, never>;
  readonly sync: <A, E, R>(effect: Effect.Effect<A, E, R>) => A;
  readonly promise: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>;
}

export const makeBridge = Effect.gen(function* () {
  const runtime = yield* Effect.runtime<unknown>();
  const runFork = Runtime.runFork(runtime);
  const runSync = Runtime.runSync(runtime);
  const runPromise = Runtime.runPromise(runtime);

  return {
    fork: (effect, options) =>
      runFork(
        effect.pipe(
          Effect.catchAllCause((cause) =>
            Effect.logError(chalk`{bold.red Unhandled error in forked bridge${options?.name ? ` [${options.name}]` : ''}}`, cause),
          ),
        ),
      ),
    sync: (effect) => runSync(effect),
    promise: (effect) => runPromise(effect),
  } as Bridge;
});

export interface RuntimeRestartOptions {
  readonly maxRestarts?: number;
  readonly intervalMs?: number;
  readonly restartDelayMs?: number;
}

export interface RuntimeOptions<ROut = unknown, E = unknown, RIn = unknown> extends RuntimeRestartOptions {
  readonly runtimeBaseLayer?: Layer.Layer<ROut, E, RIn>;
}

export const runForkWithCleanUp = <A, E, R>(effect: Effect.Effect<A, E, R>, runtime: Runtime.Runtime<R>): void => {
  const runFork = Runtime.runFork(runtime);
  const runPromise = Runtime.runPromise(runtime);

  const fiber = runFork(
    effect.pipe(
      Effect.catchAllCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logFatal('Fatal error in background process', cause);
          process.exit(1);
        }),
      ),
    ),
  );

  const cleanUp = () => {
    runPromise(Fiber.interrupt(fiber))
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };

  process.on('SIGINT', cleanUp);
  process.on('SIGTERM', cleanUp);
};

export const cycleWithRestart = <A, E, R>(
  program: Effect.Effect<A, E, R | Scope.Scope>,
  options: RuntimeRestartOptions = {},
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const { maxRestarts = 3, intervalMs = 60_000, restartDelayMs = 5_000 } = options;
    const restartTimesRef = yield* Ref.make<readonly number[]>([]);

    const loop = Effect.catchAllCause(Effect.scoped(program), (cause) =>
      Effect.gen(function* () {
        const failures = Cause.failures(cause);

        if (Chunk.some(failures, (error) => isErrorLike<{ readonly _tag: string }>(error) && error._tag === 'RuntimeRestart')) {
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
    );

    yield* Effect.repeat(loop, Schedule.forever);
  }).pipe(Effect.asVoid);

export const cycleMidnightRestart: Effect.Effect<never, RuntimeRestart> = Effect.gen(function* () {
  const now = yield* Effect.sync(() => new Date());
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const msUntilMidnight = tomorrow.getTime() - now.getTime();

  yield* Effect.sleep(`${msUntilMidnight} millis`);
  yield* Effect.logInfo(chalk`{bold.yellow It's midnight time. Restarting app...}`);
  return yield* Effect.fail(new RuntimeRestart());
});

export const runMain = <A, E, R, ROut = unknown, RE = unknown, RIn = unknown>(
  program: Effect.Effect<A, E, R | Scope.Scope>,
  options: RuntimeOptions<ROut, RE, RIn> = {},
): void => {
  const { runtimeBaseLayer, ...restartOptions } = options;

  const mainEffect = Effect.gen(function* () {
    const runtime = yield* Effect.runtime<R>();
    yield* Effect.sync(() => runForkWithCleanUp(cycleWithRestart(program, restartOptions), runtime));
    yield* Effect.never;
  }).pipe(Effect.scoped);

  const layeredEffect = runtimeBaseLayer ? mainEffect.pipe(Effect.provide(runtimeBaseLayer)) : mainEffect;

  Effect.runFork(layeredEffect as Effect.Effect<never>);
};
