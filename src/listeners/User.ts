import { container, Listener } from '@vegapunk/core';
import { Mutex } from '@vegapunk/struct';
import { chalk } from '@vegapunk/utilities';
import SteamUser from 'steam-user';

import { Session } from '../lib/struct/Session';

const OfflineState = [SteamUser.EPersonaState.Offline, SteamUser.EPersonaState.Invisible];

export class UserListener extends Listener<'user'> {
  public constructor(context: Listener.LoaderContext) {
    super(context, {
      emitter: container.steam,
      event: 'user',
    });
  }

  private readonly runMutex = new Mutex();
  public async run(session: Session, sid: NonNullable<SteamUser['steamID']>, user: Record<string, any>): Promise<void> {
    const userID = sid.toString();
    if (session.steamID === userID || typeof session.family[userID] !== 'number') {
      return;
    }

    const userPersona = user.persona_state ?? SteamUser.EPersonaState.Offline;
    const isUserOffline = OfflineState.includes(userPersona);

    await this.runMutex.acquire();
    try {
      if (session.enabled && !isUserOffline) {
        session.enabled = false;
        if (session.playing) {
          session.playing = false;
          session.client.gamesPlayed([]);
        }

        session.client.setPersona(SteamUser.EPersonaState.Invisible);
        const playerName = user.player_name || 'FamilyMember';
        container.logger.info(chalk`{yellow ${session.username} sleeping, reason: ${playerName} online.}`);
      }

      if (session.family[userID] === -1 || user.persona_state !== undefined) {
        session.family[userID] = userPersona;
      }
    } finally {
      this.runMutex.release();
    }
  }
}
