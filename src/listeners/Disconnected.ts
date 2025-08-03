import { container, Listener } from '@vegapunk/core';
import { chalk } from '@vegapunk/utilities';
import SteamUser from 'steam-user';

import { Session } from '../lib/struct/Session';

export class UserListener extends Listener<'disconnected'> {
  public constructor(context: Listener.LoaderContext) {
    super(context, {
      emitter: container.steam,
      event: 'disconnected',
    });
  }

  public run(session: Session, eresult: SteamUser.EResult, msg: string): void {
    container.logger.info(chalk`{red ${session.username} disconnected, with reason: ${eresult} ${msg}.}`);
  }
}
