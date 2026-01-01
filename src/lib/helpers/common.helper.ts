import type SteamUser from 'steam-user';
import type CSteamUser from 'steamcommunity/classes/CSteamUser';
import type { Session } from '../struct/Session';

export async function getSteamUser(session: Session, id: NonNullable<SteamUser['steamID']>): Promise<CSteamUser | null> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => resolve(null), 10_000);
    session.web.getSteamUser(id, (err, user) => {
      clearTimeout(timeoutId);
      if (err) {
        resolve(null);
        return;
      }
      resolve(user);
    });
  });
}
