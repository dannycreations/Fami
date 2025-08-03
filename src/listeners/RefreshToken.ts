import { container, Listener } from '@vegapunk/core';

import { Session } from '../lib/struct/Session';

export class UserListener extends Listener<'refreshToken'> {
  public constructor(context: Listener.LoaderContext) {
    super(context, {
      emitter: container.steam,
      event: 'refreshToken',
    });
  }

  public run(session: Session, refreshToken: string): void {
    const clientCfg = this.container.client.config;
    const userCfg = clientCfg.users.find((r) => r.username === session.username)!;
    userCfg.refreshToken = refreshToken;
  }
}
