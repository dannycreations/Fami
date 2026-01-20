import 'dotenv/config';

import { join } from 'node:path';
import { Effect, Layer, Logger } from 'effect';

import { ConfigContext, ConfigStoreTag, INITIAL_CONFIG, RegistrationSemaphore } from './core/schemas';
import { HttpClientLayer } from './structures/HttpClient';
import { LoggerClientLayer, makeLoggerClient } from './structures/LoggerClient';
import { cycleMidnightRestart, runMain } from './structures/RuntimeClient';
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

  yield* Effect.all([...config.users.map((user) => runUserWorkflow(user)), cycleMidnightRestart], {
    concurrency: 'unbounded',
  }).pipe(Effect.provideService(RegistrationSemaphore, registrationSemaphore));
});

const logger = makeLoggerClient({ exception: false, rejection: false });
const configPath = join(process.cwd(), 'sessions', 'settings.json');

const BaseLayer = Layer.mergeAll(
  HttpClientLayer,
  StoreClientLayer(ConfigStoreTag, configPath, ConfigContext, INITIAL_CONFIG, 60_000),
  LoggerClientLayer(Logger.defaultLogger, logger),
);

runMain(program, {
  runtimeBaseLayer: BaseLayer,
});
