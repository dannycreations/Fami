import 'dotenv/config';

import { join } from 'node:path';
import { Effect, Logger } from 'effect';

import { ConfigContext, ConfigStoreTag, INITIAL_CONFIG, RegistrationSemaphore } from './core/schemas';
import { HttpClientLayer } from './structures/HttpClient';
import { createLogger, LoggerClientLayer } from './structures/LoggerClient';
import { cycleMidnightRestart, cycleWithRestart, runForkWithCleanUp } from './structures/RuntimeClient';
import { StoreClientLayer } from './structures/StoreClient';
import { runUserWorkflow } from './workflows/UserWorkflow';

const program = Effect.gen(function* () {
  const configStore = yield* ConfigStoreTag;

  const config = yield* configStore.get;

  if (config.users.length === 0) {
    yield* Effect.logWarning('No users found in settings.json. Please add users to the configuration.');
    return;
  }

  yield* configStore.setDelay(config.refreshGames);

  const registrationSemaphore = yield* Effect.makeSemaphore(1);
  const semaphore = Effect.provideService(RegistrationSemaphore, registrationSemaphore);

  yield* Effect.all([...config.users.map((user) => runUserWorkflow(user).pipe(semaphore)), cycleMidnightRestart], { concurrency: 'unbounded' });
});

const logger = createLogger({ exception: false, rejection: false });
const configPath = join(process.cwd(), 'sessions', 'settings.json');

runForkWithCleanUp(
  cycleWithRestart(program).pipe(
    Effect.provide(LoggerClientLayer(Logger.defaultLogger, logger)),
    Effect.provide(StoreClientLayer(ConfigStoreTag, configPath, ConfigContext, INITIAL_CONFIG, 60_000)),
    Effect.provide(HttpClientLayer),
  ),
);
