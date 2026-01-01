import { container, Listener } from '@vegapunk/core';
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

  public run(session: Session, sid: NonNullable<SteamUser['steamID']>, user: UserStatus): void {
    const userId = sid.toString();
    if (session.steamID === userId || typeof session.family[userId] !== 'number') {
      return;
    }

    const userPersona = user.persona_state ?? SteamUser.EPersonaState.Offline;
    const isUserOffline = OFFLINE_STATE.includes(userPersona);

    if (session.isEnabled && !isUserOffline) {
      session.getState().setEnabled(false);
      session.gamesPlayed([]);

      const playerName = user.player_name || 'FamilyMember';
      container.logger.info(chalk`{yellow ${session.username} sleeping, reason: family member ${playerName} is now online.}`);
    }

    if (session.family[userId] === -1 || user.persona_state !== undefined) {
      session.family[userId] = userPersona;
    }
  }
}

interface UserStatus {
  readonly persona_state: number;
  readonly player_name: string;
}
