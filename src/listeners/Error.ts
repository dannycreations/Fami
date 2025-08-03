import { container, Listener } from '@vegapunk/core';
import { waitForConnection } from '@vegapunk/request';
import { chalk } from '@vegapunk/utilities';
import { cloneDeep } from '@vegapunk/utilities/common';
import { sleep } from '@vegapunk/utilities/sleep';
import { EResult } from 'steam-user';

import { Session } from '../lib/struct/Session';

export class UserListener extends Listener<'error'> {
  public constructor(context: Listener.LoaderContext) {
    super(context, {
      emitter: container.steam,
      event: 'error',
    });
  }

  public async run(session: Session, error: Error & { eresult: EResult }): Promise<void> {
    const clientCfg = this.container.client.config;
    const userCfg = cloneDeep(clientCfg.users.find((r) => r.username === session.username)!);
    if (error.message === 'AccessDenied' && typeof session.refreshToken === 'string') {
      session.logOff();
      userCfg.refreshToken = undefined;
    } else if (error.message === 'RateLimitExceeded') {
      session.logOff();
      await sleep(clientCfg.refreshGames);
    } else if (['LoggedInElsewhere', 'LogonSessionReplaced'].includes(error.message)) {
      session.logOff();
      await sleep(60_000 * 10);
    } else if (['NoConnection', 'ServiceUnavailable'].includes(error.message)) {
      session.logOff();
      await waitForConnection();
    }

    if (session.isExpired) {
      container.logger.info(chalk`{yellow ${userCfg.username} relogged, with reason: ${error.message}.}`);
      await sleep(10_000).then(() => Session.login(userCfg));
    } else {
      container.logger.error(error, `${userCfg.username} error, with reason: ${error.message}.`);
    }
  }
}
