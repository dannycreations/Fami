import 'dotenv/config';

import { runApp } from '@vegapunk/utilities';

import { FamiClient } from './lib/FamiClient';

async function main(): Promise<void> {
  const client = new FamiClient();
  try {
    await client.start();
  } catch (error: unknown) {
    console.trace(error);
    await client.destroy();
  }
}

void runApp(main);
