import 'dotenv/config';

import { join } from 'node:path';
import { Effect, Fiber } from 'effect';

import { ConfigContext, ConfigStore, INITIAL_CONFIG, RegistrationSemaphore } from './core/schemas';
import { HttpService } from './services/HttpService';
import { LoggerService } from './services/LoggerService';
import { runMidnightRestart, runWithRestart } from './services/RuntimeService';
import { StoreService } from './services/StoreService';
import { runUserWorkflow } from './workflows/UserWorkflow';

const program = Effect.gen(function* (_) {
  const configStore = yield* _(ConfigStore);

  const config = yield* _(configStore.get);

  if (config.users.length === 0) {
    yield* _(Effect.logWarning('No users found in settings.json. Please add users to the configuration.'));
    return;
  }

  yield* _(configStore.setDelay(config.refreshGames));

  const registrationSemaphore = yield* _(Effect.makeSemaphore(1));

  yield* _(
    Effect.all(
      [
        Effect.all(
          config.users.map((user) => runUserWorkflow(user).pipe(Effect.provideService(RegistrationSemaphore, registrationSemaphore))),
          { concurrency: 'unbounded' },
        ),
        runMidnightRestart,
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

const configPath = join(process.cwd(), 'sessions', 'settings.json');

const fiber = Effect.runFork(
  runWithRestart(programWithCatch).pipe(
    Effect.provide(LoggerService),
    Effect.provide(HttpService),
    Effect.provide(StoreService(ConfigStore, configPath, ConfigContext, INITIAL_CONFIG, 60_000)),
    Effect.scoped,
  ),
);

process.on('SIGINT', () => {
  Effect.runPromise(Fiber.interrupt(fiber)).then(() => process.exit(0));
});

process.on('SIGTERM', () => {
  Effect.runPromise(Fiber.interrupt(fiber)).then(() => process.exit(0));
});
