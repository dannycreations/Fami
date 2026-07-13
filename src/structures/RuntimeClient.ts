import { ChildProcess, fork } from 'node:child_process';
import process from 'node:process';
import { chalk } from '@vegapunk/utilities';
import { isObjectLike } from '@vegapunk/utilities/common';
import { Cause, Data, Effect, Exit, Fiber, Layer, Ref, Runtime } from 'effect';

export interface RuntimeBridge {
  readonly runFork: <A, E, R>(effect: Effect.Effect<A, E, R>) => Fiber.RuntimeFiber<A, E>;
  readonly runSync: <A, E, R>(effect: Effect.Effect<A, E, R>) => A;
  readonly runPromise: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>;
}

export const makeRuntimeBridge = Effect.gen(function* () {
  const runtime = yield* Effect.runtime<unknown>();
  return {
    runFork: Runtime.runFork(runtime),
    runSync: Runtime.runSync(runtime),
    runPromise: Runtime.runPromise(runtime),
  } as RuntimeBridge;
});

class RuntimeRestartSignal extends Data.TaggedError('RuntimeRestartSignal') {}
class RuntimeShutdownSignal extends Data.TaggedError('RuntimeShutdownSignal') {}

export interface RuntimeCycleOptions {
  readonly maxRestarts?: number;
  readonly intervalMs?: number;
  readonly restartDelayMs?: number;
  readonly logger?: Layer.Layer<never, never>;
}

export const restartMainCycle = (): Effect.Effect<never, RuntimeRestartSignal> => {
  return Effect.fail(new RuntimeRestartSignal());
};

export const shutdownMainCycle = (): Effect.Effect<never, RuntimeShutdownSignal> => {
  return Effect.fail(new RuntimeShutdownSignal());
};

export const cycleUntilMidnight = Effect.gen(function* () {
  const msUntilMidnight = yield* Effect.sync(() => {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    return tomorrow.getTime() - now.getTime();
  });

  yield* Effect.sleep(`${msUntilMidnight} millis`);
  yield* Effect.logInfo(chalk`{bold.yellow It's midnight time. Restarting system...}`);
  return yield* restartMainCycle();
});

export const runMainCycle = <A, E, R>(program: Effect.Effect<A, E, R>, options: RuntimeCycleOptions = {}): void => {
  const { maxRestarts = 3, intervalMs = 60_000, restartDelayMs = 5_000 } = options;

  if (typeof process.send === 'function') {
    const childMain = Effect.gen(function* () {
      const { runFork, runPromise } = yield* makeRuntimeBridge;

      const fiber = runFork(Effect.scoped(program));

      let cleaningUp = false;
      const cleanUp = () => {
        if (cleaningUp) {
          return;
        }

        cleaningUp = true;
        runPromise(Fiber.interrupt(fiber))
          .then(() => process.exit(0))
          .catch(() => process.exit(1));
      };

      process.once('SIGINT', cleanUp);
      process.once('SIGTERM', cleanUp);

      const exitValue = yield* Fiber.join(fiber).pipe(Effect.exit);

      process.off('SIGINT', cleanUp);
      process.off('SIGTERM', cleanUp);

      if (cleaningUp) {
        return;
      }

      if (Exit.isSuccess(exitValue)) {
        process.exit(0);
      }

      const cause = exitValue.cause;
      const failures = Cause.failures(cause);

      let signalRestart = false;
      let signalShutdown = false;
      for (const failure of failures) {
        if (!(isObjectLike(failure) && '_tag' in failure)) {
          continue;
        }

        if (failure._tag === 'RuntimeRestartSignal') {
          signalRestart = true;
          break;
        } else if (failure._tag === 'RuntimeShutdownSignal') {
          signalShutdown = true;
          break;
        }
      }

      if (signalRestart) {
        process.send?.({ type: 'restart' });
        process.exit(0);
      } else if (signalShutdown) {
        process.send?.({ type: 'shutdown' });
        process.exit(0);
      }

      yield* Effect.logError(chalk`{bold.red System encountered an error}`, cause);
      process.exit(1);
    });

    const childMainWithLogger = options.logger ? childMain.pipe(Effect.provide(options.logger)) : childMain;
    Effect.runPromise(childMainWithLogger as Effect.Effect<never, never, never>);
    return;
  }

  const runChildProcess = (currentChildRef: { current: ChildProcess | null }) => {
    return Effect.async<{ code: number | null; signal: NodeJS.Signals | null; action: 'restart' | 'shutdown' | null }, never, never>((resume) => {
      const cleanUp = () => {
        if (currentChildRef.current) {
          try {
            currentChildRef.current.kill('SIGTERM');
          } catch {}
          currentChildRef.current = null;
        }
      };

      cleanUp();

      const child = fork(process.argv[1], process.argv.slice(2), {
        execPath: process.execPath,
        stdio: 'inherit',
      });
      currentChildRef.current = child;

      let action: 'restart' | 'shutdown' | null = null;
      let resolved = false;

      const handleMessage = (message: unknown) => {
        if (isObjectLike(message) && 'type' in message) {
          if (message.type === 'restart') {
            action = 'restart';
          } else if (message.type === 'shutdown') {
            action = 'shutdown';
          }
        }
      };

      const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (resolved) {
          return;
        }

        resolved = true;
        currentChildRef.current = null;
        resume(Effect.succeed({ code, signal, action }));
      };

      const handleError = () => handleExit(1, null);

      child.on('message', handleMessage);
      child.once('exit', handleExit);
      child.once('error', handleError);

      return Effect.sync(() => {
        child.off('message', handleMessage);
        child.off('exit', handleExit);
        child.off('error', handleError);
        cleanUp();
      });
    });
  };

  const parentMain = Effect.gen(function* () {
    const restartTimesRef = yield* Ref.make<readonly number[]>([]);
    const currentChildRef = { current: null as ChildProcess | null };

    let isShuttingDown = false;
    const cleanUp = (signal: NodeJS.Signals) => {
      if (isShuttingDown) {
        return;
      }

      isShuttingDown = true;
      if (currentChildRef.current) {
        try {
          currentChildRef.current.kill(signal);
        } catch {}
      } else {
        process.exit(0);
      }
    };

    const onSigInt = () => cleanUp('SIGINT');
    const onSigTerm = () => cleanUp('SIGTERM');

    process.once('SIGINT', onSigInt);
    process.once('SIGTERM', onSigTerm);

    try {
      while (true) {
        const { code, signal, action } = yield* runChildProcess(currentChildRef);

        if (isShuttingDown) {
          process.exit(0);
        }

        if (signal === 'SIGINT' || signal === 'SIGTERM') {
          yield* Effect.logInfo(chalk`{bold.yellow Child process requested ${signal}. Parent exiting.}`);
          process.exit(0);
        }

        if (action === 'shutdown') {
          yield* Effect.logInfo(chalk`{bold.green Child process requested SHUTDOWN. Parent exiting.}`);
          process.exit(0);
        }

        if (action === 'restart' || code === 0) {
          yield* Ref.set(restartTimesRef, []);
          continue;
        }

        const now = Date.now();
        const restartTimes = yield* Ref.get(restartTimesRef);
        const nextRestarts = [...restartTimes.filter((t) => now - t < intervalMs), now];
        yield* Ref.set(restartTimesRef, nextRestarts);

        if (nextRestarts.length >= maxRestarts) {
          yield* Effect.logFatal(chalk`{bold.red System crashed too many times. Shutting down...}`);
          process.exit(1);
        }

        yield* Effect.logInfo(chalk`{bold.yellow Restarting in ${restartDelayMs / 1000}s (${nextRestarts.length}/${maxRestarts})...}`);
        yield* Effect.sleep(`${restartDelayMs} millis`);
      }
    } finally {
      process.off('SIGINT', onSigInt);
      process.off('SIGTERM', onSigTerm);
    }
  });

  const parentMainWithLogger = options.logger ? parentMain.pipe(Effect.provide(options.logger)) : parentMain;
  Effect.runPromise(parentMainWithLogger as Effect.Effect<never, never, never>);
};
