import { container, Listener } from '@vegapunk/core';

import { Session } from '../lib/struct/Session';

export class RefreshTokenListener extends Listener<'refreshToken'> {
  public constructor(context: Listener.LoaderContext) {
    super(context, {
      emitter: container.steam,
      event: 'refreshToken',
    });
  }

  public run(session: Session, refreshToken: string): void {
    const clientConfig = this.container.client.config;
    const userConfig = clientConfig.users.find((user) => user.username === session.username)!;
    userConfig.refreshToken = refreshToken;
  }
}
