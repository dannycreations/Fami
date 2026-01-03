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
    this.container.client.updateUser(session.username, { refreshToken });
  }
}
