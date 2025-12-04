import type SteamUser from 'steam-user';
import type CSteamUser from 'steamcommunity/classes/CSteamUser';
import type { Session } from '../struct/Session';

export async function getSteamUser(session: Session, id: NonNullable<SteamUser['steamID']>): Promise<CSteamUser> {
  return new Promise((resolve) => {
    session.web.getSteamUser(id, (err, user) => {
      resolve((err as any) ?? user);
    });
  });
}
