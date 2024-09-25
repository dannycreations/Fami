import { container, Listener } from '@vegapunk/core'
import { SessionContext } from '../lib/FamiClient'

export class UserListener extends Listener {
	public constructor(context: Listener.LoaderContext) {
		super(context, { emitter: container.steam })
	}

	public run(user: SessionContext, refreshToken: string) {
		const { config } = this.container.client
		const luser = config.users.find((r) => r.username === user.username)
		luser.refreshToken = refreshToken
	}
}
