import 'dotenv/config';

import { join } from 'node:path';
import { Effect, Logger } from 'effect';

import { ConfigContext, ConfigStoreTag, INITIAL_CONFIG, RegistrationSemaphore } from './core/schemas';
import { HttpClientLayer } from './structures/HttpClient';
import { createLogger, LoggerClientLayer } from './structures/LoggerClient';
import { cycleMidnightRestart, cycleWithRestart, runForkWithCleanUp } from './structures/RuntimeClient';
import { StoreClientLayer } from './structures/StoreClient';
import { runUserWorkflow } from './workflows/UserWorkflow';

const program = Effect.gen(function* (_) {
  const configStore = yield* _(ConfigStoreTag);

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
    Effect.provide(LoggerClientLayer(Logger.defaultLogger, logger)),
    Effect.provide(StoreClientLayer(ConfigStoreTag, configPath, ConfigContext, INITIAL_CONFIG, 60_000)),
    Effect.provide(HttpClientLayer),
  ),
);
