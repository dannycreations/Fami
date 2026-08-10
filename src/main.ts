import 'dotenv/config';

import { join } from 'node:path';
import { Effect, Layer } from 'effect';

import { ConfigContext, ConfigStoreTag, INITIAL_CONFIG, RegistrationSemaphore } from './core/schemas.js';
import { HttpClientLayer } from './structures/HttpClient.js';
import { LoggerClientLayer } from './structures/LoggerClient.js';
import { cycleUntilMidnight, runMainCycle } from './structures/RuntimeClient.js';
import { StoreClientLayer } from './structures/StoreClient.js';
import { runUserWorkflow } from './workflows/UserWorkflow.js';

const program = Effect.gen(function* () {
  const configStore = yield* ConfigStoreTag;
  const config = yield* configStore.get;

  if (config.users.length === 0) {
    yield* Effect.logWarning('No users found in settings.json. Please add users to the configuration.');
    return;
  }

  yield* configStore.setDelay(config.refreshGames);

  const registrationSemaphore = yield* Effect.makeSemaphore(1);

  yield* Effect.all([cycleUntilMidnight, ...config.users.map((user) => runUserWorkflow(user))], {
    concurrency: 'unbounded',
  }).pipe(Effect.provideService(RegistrationSemaphore, registrationSemaphore));
});

const logger = LoggerClientLayer();
const configPath = join(process.cwd(), 'sessions', 'settings.json');

const BaseLayer = Layer.mergeAll(HttpClientLayer, StoreClientLayer(ConfigStoreTag, configPath, ConfigContext, INITIAL_CONFIG, 60_000), logger);

runMainCycle(program.pipe(Effect.provide(BaseLayer)), { logger });
