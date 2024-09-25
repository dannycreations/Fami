import { container, Listener } from '@vegapunk/core'
import { chalk } from '@vegapunk/utilities'
import SteamUser from 'steam-user'
import { SessionContext } from '../lib/FamiClient'

export class UserListener extends Listener {
	public constructor(context: Listener.LoaderContext) {
		super(context, { emitter: container.steam })
	}

	public run(user: SessionContext, eresult: SteamUser.EResult, msg: string) {
		container.logger.info(chalk`{red ${user.username} disconnected, with reason: ${eresult} ${msg}}`)
	}
}
