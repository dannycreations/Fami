import { container, Listener } from '@vegapunk/core'
import { sleep } from '@vegapunk/utilities'
import { createInterface } from 'node:readline'
import SteamTotp from 'steam-totp'
import { SessionContext } from '../lib/FamiClient'

export class UserListener extends Listener {
	public constructor(context: Listener.LoaderContext) {
		super(context, { emitter: container.steam })
	}

	public async run(user: SessionContext, domain: string | null, callback: (code: string) => void, lastCodeWrong: boolean) {
		if (lastCodeWrong) {
			container.logger.info(`${user.username} Steam Guard wrong.`)
			await sleep(10_000)
		} else {
			if (user.isSteamGuard) return
			user.isSteamGuard = true
		}

		container.logger.info(`${user.username} need Steam Guard.`)
		if (typeof user.secret === 'string') {
			const twoFactorCode = SteamTotp.generateAuthCode(user.secret)
			container.logger.info(`${user.username} used ${twoFactorCode} as Steam Guard.`)
			callback(twoFactorCode)
		} else {
			const rl = createInterface({ input: process.stdin, output: process.stdout })
			rl.question(`${user.username} Steam Guard` + (!domain ? ' App' : '') + ' Code: ', (code) => {
				rl.close()
				callback(code)
			})
		}
	}
}
