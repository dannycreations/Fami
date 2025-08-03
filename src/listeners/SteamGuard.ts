import { createInterface } from 'node:readline';
import { container, Listener } from '@vegapunk/core';
import { sleep } from '@vegapunk/utilities/sleep';
import SteamTotp from 'steam-totp';

import { Session } from '../lib/struct/Session';

export class UserListener extends Listener<'steamGuard'> {
  public constructor(context: Listener.LoaderContext) {
    super(context, {
      emitter: container.steam,
      event: 'steamGuard',
    });
  }

  public async run(session: Session, domain: string | null, callback: (code: string) => void, lastCodeWrong: boolean): Promise<void> {
    if (lastCodeWrong) {
      container.logger.info(`${session.username} Steam Guard wrong.`);
      await sleep(10_000);
    }

    container.logger.info(`${session.username} need Steam Guard.`);
    if (typeof session.secret === 'string') {
      const twoFactorCode = SteamTotp.generateAuthCode(session.secret);
      container.logger.info(`${session.username} used ${twoFactorCode} as Steam Guard.`);
      callback(twoFactorCode);
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`${session.username} Steam Guard` + (!domain ? ' App' : '') + ' Code: ', (r) => (rl.close(), callback(r)));
    }
  }
}
