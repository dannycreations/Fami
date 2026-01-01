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

    session.logOff();
    container.logger.info(error, chalk`{red ${session.username} disconnected.}`);

    switch (error.message) {
      case 'AccessDenied':
        userConfig.refreshToken = undefined;
        break;
      case 'RateLimitExceeded':
        await sleep(clientConfig.refreshGames);
        break;
      case 'LoggedInElsewhere':
      case 'LogonSessionReplaced':
        await sleep(600_000); // 10 minutes
        break;
      case 'NoConnection':
      case 'ServiceUnavailable':
        await waitForConnection();
        break;
    }

    container.logger.info(chalk`{yellow ${userConfig.username} relogged.}`);
    await sleep(10_000);
    await Session.login(userConfig);
  }
}
