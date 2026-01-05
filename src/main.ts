import 'dotenv/config';

import { join } from 'node:path';
import { chalk } from '@vegapunk/utilities';
import { Effect, Fiber } from 'effect';

import { ConfigContext } from './schemas/Domain';
import { LoggerLive } from './services/LoggerService';
import { makeStore } from './services/StoreService';
import { runUserWorkflow } from './workflows/UserWorkflow';

const initialConfig: ConfigContext = {
  refreshGames: 3_600_000,
  fetchFreeGames: false,
  skipBannedGames: true,
  whitelistGameIds: [],
  blacklistGameIds: [],
  family: [],
  users: [],
};

const program = Effect.gen(function* (_) {
  const configPath = join(process.cwd(), 'sessions', 'settings.json');
  const configStore = yield* _(makeStore(configPath, ConfigContext, initialConfig, 60_000));

  let config = yield* _(configStore.get);

  if (config.users.length === 0) {
    yield* _(Effect.logWarning('No users found in settings.json. Please add users to the configuration.'));
    return;
  }

  yield* _(configStore.setDelay(config.refreshGames));

  const registrationSemaphore = yield* _(Effect.makeSemaphore(1));

  const midnightCheck = Effect.gen(function* (_) {
    let lastCheckedDay = new Date().getDate();

    while (true) {
      yield* _(Effect.sleep('10 seconds'));
      const currentDay = new Date().getDate();

      if (currentDay !== lastCheckedDay) {
        lastCheckedDay = currentDay;
        yield* _(Effect.logInfo(chalk`{bold.yellow It's midnight time. Restarting app...}`));
        process.exit(0);
      }
    }
  });

  yield* _(
    Effect.all(
      [
        Effect.all(
          config.users.map((user) => runUserWorkflow(user, configStore, registrationSemaphore)),
          { concurrency: 'unbounded' },
        ),
        midnightCheck,
      ],
      { concurrency: 'unbounded' },
    ),
  );

  yield* _(configStore.dispose);
});

const runtime = program.pipe(
  Effect.catchAllCause((cause) => Effect.logError(cause)),
  Effect.provide(LoggerLive),
  Effect.scoped,
);

const fiber = Effect.runFork(runtime);

process.on('SIGINT', () => {
  Effect.runPromise(Fiber.interrupt(fiber)).then(() => process.exit(0));
});

process.on('SIGTERM', () => {
  Effect.runPromise(Fiber.interrupt(fiber)).then(() => process.exit(0));
});
