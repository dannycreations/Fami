import { container, Listener, Task } from '@vegapunk/core'
import { requestDefault } from '@vegapunk/request'
import { _, chalk, humanizeDuration, parseJsonc, sleep } from '@vegapunk/utilities'
import SteamUser from 'steam-user'
import { GameContext, SessionContext } from '../lib/FamiClient'
import { AppDetails } from '../lib/types/AppDetails'

const KEY_START_IDLER = (key: string) => `${key}_START_IDLER`
const KEY_FREE_GAMES = (key: string) => `${key}_FREE_GAMES`

export class UserListener extends Listener {
	public constructor(context: Listener.LoaderContext) {
		super(context, { emitter: container.steam })
	}

	public async run(user: SessionContext) {
		const client = this.container.client

		clearTimeout(user.timeout)
		user.isSteamGuard = undefined
		container.logger.info(chalk`{bold.yellow ${user.username} logged on!}`)
		user.client.setPersona(SteamUser.EPersonaState.Online)

		user.isLogged = true
		await this.createGameList(user)
		if (client.config.fetchFreeGames || user.fetchFreeGames) {
			const freeGameTask = await Task.createTask({
				update: async () => {
					if (client.isSessionExpired(user)) {
						return freeGameTask.unload()
					}

					await this.claimFreeGames(user)
				},
				options: { name: KEY_FREE_GAMES(user.id), delay: 60_000 },
			})
		}

		if (!user.ownedGameList.length) return container.logger.info(`${user.username} have no games to idle.`)
		else container.logger.info(`${user.username} owns ${user.ownedGameList.length} game(s).`)

		let endIdle = this.gamesToIdle(user)
		let endRefresh = Date.now() + client.config.refreshGames
		const mainTask = await Task.createTask({
			update: async () => {
				if (client.isSessionExpired(user)) {
					return mainTask.unload()
				}

				if (endRefresh < Date.now()) {
					await this.createGameList(user)
					endRefresh = Date.now() + client.config.refreshGames
				}

				if (endIdle < Date.now()) {
					endIdle = this.gamesToIdle(user)
				}
			},
			options: { name: KEY_START_IDLER(user.id), delay: 2_500 },
		})
	}

	private async createGameList(user: SessionContext, retry: number = 0): Promise<void> {
		const client = this.container.client
		if (client.isSessionExpired(user) || retry >= 3) return

		const includeGameIds = _.union(client.config.whitelistGameIds, user.whitelistGameIds)
		const excludeGameIds = _.union(
			client.config.blacklistGameIds,
			user.blacklistGameIds,
			user.bannedGameIds,
			user.ownedGameList.map((r) => r.appid),
		)

		let timeout: NodeJS.Timeout
		try {
			const userOwnedApps = await new Promise<{ apps: GameContext[] }>(async (resolve, reject) => {
				timeout = setTimeout(() => reject('Request timed out'), 60_000)
				user.client
					.getUserOwnedApps(user.client.steamID, {
						// @ts-expect-error
						includeAppInfo: true,
						includeFreeSub: true,
						skipUnvettedApps: false,
						includePlayedFreeGames: true,
					})
					.then(resolve)
					.catch(reject)
			})

			clearTimeout(timeout)
			const includeGameLists = _.unionBy(
				userOwnedApps.apps,
				includeGameIds.map((appid) => ({ name: 'unknown', appid })),
				'appid',
			)

			for (const game of includeGameLists) {
				if (excludeGameIds.includes(game.appid)) continue
				if (game.name.match(/(\sPTS|PTS\s)/gi)) continue
				if (game.name.match(/(\sBeta|Beta\s)/gi)) continue
				if (game.name.match(/(\sTest|Test\s)/gi)) continue
				if (game.name.match(/(\sUnstable|Unstable\s)/gi)) continue

				user.ownedGameList.push({ name: game.name, appid: game.appid })
			}
		} catch (error) {
			if (user.ownedGameList.length) return
			if (error.message !== 'Request timed out') {
				container.logger.error(error, `Stage 1 ${user.username}, with reason: ${error.message}`)
			}

			await sleep(10_000)
			return this.createGameList(user, retry++)
		} finally {
			clearTimeout(timeout)
		}
	}

	private async claimFreeGames(user: SessionContext, retry: number = 0): Promise<void> {
		const client = this.container.client
		if (client.isSessionExpired(user) || retry >= 3) return

		user.lastPage ??= 1
		user.freeGameList ??= []
		user.freeGameIds ??= []

		user.lastLoop ??= 0
		user.freeGameLength ?? 0

		const excludeGameIds = _.union(
			client.config.blacklistGameIds,
			user.blacklistGameIds,
			user.bannedGameIds,
			user.ownedGameList.map((r) => r.appid),
		)

		try {
			const { body } = await requestDefault({
				url: 'https://store.steampowered.com/search/results',
				searchParams: {
					sort_by: 'Released_DESC',
					force_infinite: 1,
					maxprice: 'free',
					category1: '998,10',
					os: 'win',
					page: user.lastPage,
				},
				retry: -1,
			})

			const gameSearch = body.match(/(?<=data-ds-appid=")[^"]*/g)
			if (gameSearch?.length) {
				const parseResult = gameSearch.map((r) => parseInt(r))
				for (const appid of parseResult) {
					if (excludeGameIds.includes(appid)) continue
					if (user.freeGameIds.includes(appid)) continue
					if (user.freeGameList.some((r) => r.appid === appid)) continue

					let json: AppDetails
					try {
						const { body } = await requestDefault({
							url: `https://store.steampowered.com/api/appdetails?appids=${appid}`,
							retry: -1,
						})
						json = parseJsonc(body)
						await sleep(1_500)
					} catch {
					} finally {
						if (typeof json !== 'object') {
							excludeGameIds.push(appid)
							continue
						}
					}

					if (!json[appid].success) continue
					if (!json[appid].data.is_free) continue
					if (json[appid].data.release_date.coming_soon) continue

					user.freeGameIds.push(appid)
					user.freeGameList.push({
						name: json[appid].data.name,
						appid: json[appid].data.steam_appid,
					})
				}

				user.lastPage++
			} else {
				if (user.lastLoop >= 5) {
					user.lastPage = undefined
					user.freeGameIds = []
					user.forceRequest = true
				}

				if (user.freeGameList.length === user.freeGameLength) user.lastLoop++
				user.freeGameLength = user.freeGameList.length
			}

			const luser = client.sessions.get(user.username)
			await luser.store.writeFile({
				lastPage: user.lastPage,
				freeGameList: user.freeGameList,
				freeGameIds: user.freeGameIds,
			})
		} catch (error) {
			container.logger.error(error, `Stage 4 ${user.username}, with reason: ${error.message}`)

			await sleep(10_000)
			return this.claimFreeGames(user, retry++)
		} finally {
			await this.requestFreeGameLicense(user)
		}
	}

	private async requestFreeGameLicense(user: SessionContext, retry: number = 0): Promise<void> {
		const client = this.container.client
		if (client.isSessionExpired(user) || retry >= 3) return
		if (!(user.freeGameList.length >= 50 || user.forceRequest)) return

		const takeGames = user.freeGameList.slice(0, 50)
		const takeGameIds = takeGames.map((r) => r.appid)

		try {
			await user.client.requestFreeLicense(takeGameIds)
		} catch (error) {
			if (error.message !== 'Request timed out') {
				container.logger.error(error, `Stage 3 ${user.username}, with reason: ${error.message}`)
			}

			await sleep(10_000)
			return this.requestFreeGameLicense(user, retry++)
		}

		container.logger.info(`${user.username} has added ${takeGames.length}/${user.freeGameList.length}/${user.lastPage} new games.`)
		_.pullAllBy(user.freeGameList, takeGames, 'appid')

		user.lastLoop = undefined
		if (user.forceRequest) {
			user.forceRequest = undefined
			user.freeGameLength = undefined
		}

		const luser = client.sessions.get(user.username)
		await luser.store.writeFile({
			lastPage: user.lastPage,
			freeGameList: user.freeGameList,
			freeGameIds: user.freeGameIds,
		})
	}

	private gamesToIdle(user: SessionContext) {
		const maxIdle = Math.min(32, user.ownedGameList.length)
		const idleTime = _.random(60, 120) * 60_000
		const endIdle = Date.now() + idleTime

		const gameIds = user.ownedGameList.map((r) => r.appid)
		const takeGameIds = _.shuffle(gameIds).slice(0, maxIdle)

		const humanize = humanizeDuration(idleTime, { round: true })
		container.logger.info(`${user.username} idling for ${humanize}.`)
		container.logger.info(`• ${takeGameIds.join(', ')}`)
		user.client.gamesPlayed(takeGameIds)
		return endIdle
	}
}
