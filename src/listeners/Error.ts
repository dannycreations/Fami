import { container, Listener } from '@vegapunk/core';
import { waitForConnection } from '@vegapunk/request';
import { chalk } from '@vegapunk/utilities';
import { cloneDeep } from '@vegapunk/utilities/common';
import { sleep } from '@vegapunk/utilities/sleep';

import { Session } from '../lib/struct/Session';

import type { EResult } from 'steam-user';

export class ErrorListener extends Listener<'error'> {
  public constructor(context: Listener.LoaderContext) {
    super(context, {
      emitter: container.steam,
      event: 'error',
    });
  }

  public async run(session: Session, error: Error & { eresult: EResult }): Promise<void> {
    const clientConfig = this.container.client.config;
    const userConfig = cloneDeep(clientConfig.users.find((user) => user.username === session.username)!);

    if (error.message === 'AccessDenied') {
      session.logOff();
      userConfig.refreshToken = undefined;
    } else if (error.message === 'RateLimitExceeded') {
      session.logOff();
      await sleep(clientConfig.refreshGames);
    } else if (['LoggedInElsewhere', 'LogonSessionReplaced'].includes(error.message)) {
      session.logOff();
      await sleep(60_000 * 10);
    } else if (['NoConnection', 'ServiceUnavailable'].includes(error.message)) {
      session.logOff();
      await waitForConnection();
    }

    if (session.isExpired) {
      container.logger.info(chalk`{yellow ${userConfig.username} relogged, with reason: ${error.message}.}`);
      await sleep(10_000).then(() => Session.login(userConfig));
    } else {
      container.logger.error(error, `${userConfig.username} error, with reason: ${error.message}.`);
    }
  }
}
