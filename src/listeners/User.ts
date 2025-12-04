import { container, Listener } from '@vegapunk/core';
import { Mutex } from '@vegapunk/struct';
import { chalk } from '@vegapunk/utilities';
import SteamUser from 'steam-user';

import { Session } from '../lib/struct/Session';

const OFFLINE_STATE = [SteamUser.EPersonaState.Offline, SteamUser.EPersonaState.Invisible] as const;

export class UserListener extends Listener<'user'> {
  public constructor(context: Listener.LoaderContext) {
    super(context, {
      emitter: container.steam,
      event: 'user',
    });
  }

  private readonly runMutex = new Mutex();
  public async run(session: Session, sid: NonNullable<SteamUser['steamID']>, user: UserStatus): Promise<void> {
    const userId = sid.toString();
    if (session.steamID === userId || typeof session.family[userId] !== 'number') {
      return;
    }

    const userPersona = user.persona_state ?? SteamUser.EPersonaState.Offline;
    const isUserOffline = OFFLINE_STATE.includes(userPersona);

    await this.runMutex.acquire();
    try {
      if (session.isEnabled && !isUserOffline) {
        session.getState().setEnabled(false);
        session.gamesPlayed([]);

        const playerName = user.player_name || 'FamilyMember';
        container.logger.info(chalk`{yellow ${session.username} sleeping, reason: ${playerName} online.}`);
      }

      if (session.family[userId] === -1 || user.persona_state !== undefined) {
        session.family[userId] = userPersona;
      }
    } finally {
      this.runMutex.release();
    }
  }
}

interface UserStatus {
  readonly persona_state: number;
  readonly player_name: string;
}
