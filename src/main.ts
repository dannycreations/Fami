import 'dotenv/config';

import { join } from 'node:path';
import { chalk } from '@vegapunk/utilities';
import { Data, Effect, Fiber } from 'effect';

import { ConfigContext, INITIAL_CONFIG, RegistrationSemaphore } from './core/schemas';
import { LoggerLive } from './services/LoggerService';
import { runWithRestart } from './services/RuntimeService';
import { makeStore } from './services/StoreService';
import { runUserWorkflow } from './workflows/UserWorkflow';

class RestartRequested extends Data.TaggedError('RestartRequested') {}

const program = Effect.gen(function* (_) {
  const configPath = join(process.cwd(), 'sessions', 'settings.json');
  const configStore = yield* _(makeStore(configPath, ConfigContext, INITIAL_CONFIG, 60_000));

  const config = yield* _(configStore.get);

  if (config.users.length === 0) {
    yield* _(Effect.logWarning('No users found in settings.json. Please add users to the configuration.'));
    return;
  }

  yield* _(configStore.setDelay(config.refreshGames));

  const registrationSemaphore = yield* _(Effect.makeSemaphore(1));

  const midnightCheck = Effect.gen(function* (_) {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const msUntilMidnight = tomorrow.getTime() - now.getTime();

    yield* _(Effect.sleep(`${msUntilMidnight} millis`));
    yield* _(Effect.logInfo(chalk`{bold.yellow It's midnight time. Restarting app...}`));
    return yield* _(Effect.fail(new RestartRequested()));
  });

  yield* _(
    Effect.all(
      [
        Effect.all(
          config.users.map((user) => runUserWorkflow(user, configStore).pipe(Effect.provideService(RegistrationSemaphore, registrationSemaphore))),
          { concurrency: 'unbounded' },
        ),
        midnightCheck,
      ],
      { concurrency: 'unbounded' },
    ),
  );
});

const programWithCatch = program.pipe(
  Effect.catchAll((error) => {
    if (error && typeof error === 'object' && '_tag' in error && error._tag === 'RestartRequested') {
      return Effect.void;
    }
    return Effect.fail(error);
  }),
);

const fiber = Effect.runFork(runWithRestart(programWithCatch).pipe(Effect.provide(LoggerLive), Effect.scoped));

process.on('SIGINT', () => {
  Effect.runPromise(Fiber.interrupt(fiber)).then(() => process.exit(0));
});

process.on('SIGTERM', () => {
  Effect.runPromise(Fiber.interrupt(fiber)).then(() => process.exit(0));
});
