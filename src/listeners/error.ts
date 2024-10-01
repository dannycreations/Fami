import { container, Listener } from '@vegapunk/core'
import { requestDefault, waitForConnection } from '@vegapunk/request'
import { _, chalk, sleep, sleepUntil } from '@vegapunk/utilities'
import { EResult } from 'steam-user'
import { SessionContext } from '../lib/FamiClient'

export class UserListener extends Listener {
	public constructor(context: Listener.LoaderContext) {
		super(context, { emitter: container.steam })
	}

	public async run(user: SessionContext, error: Error & { eresult: EResult }) {
		const client = this.container.client

		const vanityURL = user.client.vanityURL
		const userConfig = _.cloneDeep(client.config.users.find((r) => r.username === user.username))
		if (error.eresult === EResult.AccessDenied && typeof user.refreshToken === 'string') {
			client.logOff(user)

			userConfig.refreshToken = undefined
		} else if (error.eresult === EResult.RateLimitExceeded) {
			client.logOff(user)

			await sleep(client.config.refreshGames)
		} else if (error.eresult === EResult.LoggedInElsewhere) {
			client.logOff(user)

			await this.waitForPersonaStatus(vanityURL)
		} else if ([EResult.NoConnection, EResult.ServiceUnavailable].includes(error.eresult)) {
			client.logOff(user)

			await waitForConnection()
			await this.waitForPersonaStatus(vanityURL)
		} else {
			container.logger.error(error, `Stage 0 ${user.username}, with reason: ${error.message}`)
		}

		if (client.isSessionExpired(user)) {
			container.logger.info(chalk`{yellow ${user.username} relogged, with reason: ${error.message}}`)
			user.timeout = setTimeout(() => client.login(userConfig), 10_000).unref()
		}
	}

	private async waitForPersonaStatus(username: string) {
		if (typeof username !== 'string') return

		let status = 2
		await sleepUntil(async () => {
			try {
				const { body } = await requestDefault({
					url: `https://steamcommunity.com/id/${username}`,
					retry: -1,
				})

				const gameHeader = body.match(/(?<=profile_in_game_header">)[^<]*/)?.[0]
				if (!!~gameHeader.indexOf('Offline')) status = 0
				else if (!!~gameHeader.indexOf('Online')) status = 1
			} catch {
			} finally {
				return status <= 1
			}
		})
	}
}
