import { container, Listener } from '@vegapunk/core';
import { waitForConnection } from '@vegapunk/request';
import { chalk } from '@vegapunk/utilities';
import { cloneDeep } from '@vegapunk/utilities/common';
import { sleep } from '@vegapunk/utilities/sleep';
import { EResult } from 'steam-user';

import { Session } from '../lib/struct/Session';

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
    container.logger.info(error, chalk`{red ${session.username} disconnected}`);

    switch (error.eresult) {
      case EResult.AccessDenied:
      case EResult.InvalidPassword:
        userConfig.refreshToken = undefined;
        break;
      case EResult.RateLimitExceeded:
        // At least 30 minutes for rate limits
        await sleep(Math.max(clientConfig.refreshGames, 1_800_000));
        break;
      case EResult.LoggedInElsewhere:
      case EResult.LogonSessionReplaced:
        // 10 minutes
        await sleep(600_000);
        break;
      case EResult.NoConnection:
      case EResult.ServiceUnavailable:
        await waitForConnection();
        break;
    }

    container.logger.info(chalk`{yellow ${userConfig.username} relogged}`);
    await sleep(10_000);
    await Session.login(userConfig);
  }
}
