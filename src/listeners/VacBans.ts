import { container, Listener } from '@vegapunk/core';

import { Session } from '../lib/struct/Session';

export class UserListener extends Listener<'vacBans'> {
  public constructor(context: Listener.LoaderContext) {
    super(context, {
      emitter: container.steam,
      event: 'vacBans',
    });
  }

  public run(session: Session, numBans: number, appids: number[]): void {
    if (numBans === 0) {
      container.logger.info(`${session.username} has no VAC bans.`);
      return;
    }

    const clientCfg = this.container.client.config;
    if (clientCfg.skipBannedGames) {
      session.bannedGameIds = appids;
    }

    container.logger.info(`${session.username} has ${numBans} VAC ban(s).`);
    container.logger.info(`• ${appids.join(', ')}.`);
  }
}
