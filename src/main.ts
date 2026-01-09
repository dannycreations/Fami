import 'dotenv/config';

import { join } from 'node:path';
import { Effect, Logger } from 'effect';

import { ConfigContext, ConfigStore, INITIAL_CONFIG, RegistrationSemaphore } from './core/schemas';
import { HttpService } from './services/HttpService';
import { createLogger, LoggerService } from './services/LoggerService';
import { cycleMidnightRestart, cycleWithRestart, runForkWithCleanUp } from './services/RuntimeService';
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
  const semaphore = Effect.provideService(RegistrationSemaphore, registrationSemaphore);

  yield* _(Effect.all([...config.users.map((user) => runUserWorkflow(user).pipe(semaphore)), cycleMidnightRestart], { concurrency: 'unbounded' }));
});

const logger = createLogger({ exception: false, rejection: false });
const configPath = join(process.cwd(), 'sessions', 'settings.json');

runForkWithCleanUp(
  cycleWithRestart(program).pipe(
    Effect.provide(LoggerService(Logger.defaultLogger, logger)),
    Effect.provide(StoreService(ConfigStore, configPath, ConfigContext, INITIAL_CONFIG, 60_000)),
    Effect.provide(HttpService),
    Effect.scoped,
  ),
);
