import { container, Listener, Task } from '@vegapunk/core';
import { chalk } from '@vegapunk/utilities';
import SteamUser from 'steam-user';

import { getSteamUser } from '../lib/helpers/common.helper';
import { collectFreeGames } from '../lib/services/free-game.service';
import { scanGames, updateEnabledState } from '../lib/services/game-scanner.service';
import { startIdleGames } from '../lib/services/idle-manager.service';
import { Session } from '../lib/struct/Session';

export class LoggedOnListener extends Listener<'loggedOn'> {
  public constructor(context: Listener.LoaderContext) {
    super(context, {
      emitter: container.steam,
      event: 'loggedOn',
    });
  }

  public async run(session: Session): Promise<void> {
    const clientConfig = container.client.config;
    const userConfig = clientConfig.users.find((user) => user.username === session.username)!;
    Object.assign(userConfig, { id: session.client.steamID!.toString() });

    session.client.setPersona(SteamUser.EPersonaState.Invisible);
    container.logger.info(chalk`{bold.yellow ${session.username} logged on!}`);

    await scanGames(session);
    container.logger.info(`${session.username} owns ${session.ownedGameList.length} game(s)`);

    let nextIdleTime = 0;
    let nextGameRefreshTime = Date.now() + clientConfig.refreshGames;

    const sessionTask = await Task.createTask({
      start: () => sessionTask.update(),
      update: async () => {
        if (session.isExpired) {
          return sessionTask.unload();
        }

        // Family & State Monitoring
        if (Object.values(session.family).some((value) => value > 0)) {
          session.getState().setEnabled(false);
        } else if (!session.isPlaying) {
          const steamUser = await getSteamUser(session, session.client.steamID!);
          updateEnabledState(session, steamUser);
        }

        // Free Game Collection
        if (clientConfig.fetchFreeGames || session.fetchFreeGames) {
          await collectFreeGames(session);
        }

        // Idling & Refreshing
        if (!session.isEnabled) {
          nextIdleTime = 0;
          session.gamesPlayed([]);
          return;
        }

        if (nextGameRefreshTime < Date.now()) {
          await scanGames(session);
          nextGameRefreshTime = Date.now() + clientConfig.refreshGames;
        }

        if (nextIdleTime < Date.now()) {
          nextIdleTime = startIdleGames(session);
        }
      },
      options: { name: session.sessionID, delay: 60_000 },
    });
  }
}
