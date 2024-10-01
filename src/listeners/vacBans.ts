import { container, Listener } from '@vegapunk/core'
import { SessionContext } from '../lib/FamiClient'

export class UserListener extends Listener {
	public constructor(context: Listener.LoaderContext) {
		super(context, { emitter: container.steam })
	}

	public run(user: SessionContext, numBans: number, appids: number[]) {
		const { config } = this.container.client

		if (!numBans) return container.logger.info(`${user.username} has no VAC bans.`)
		if (config.skipBannedGames) user.bannedGameIds = appids

		container.logger.info(`${user.username} has ${numBans} VAC ban(s).`)
		container.logger.info(`• ${appids.join(', ')}`)
	}
}
