import 'dotenv/config';

import { FamiClient } from './lib/FamiClient';

const client = new FamiClient();

async function main() {
  try {
    await client.start();
  } catch (error) {
    console.trace(error);
    await client.destroy();
  }
}

main().catch(console.trace);
