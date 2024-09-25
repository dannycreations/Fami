import { container, Vegapunk } from '@vegapunk/core'
import { sleepUntil, VegapunkSnowflake } from '@vegapunk/utilities'
import { EventEmitter } from 'node:events'
import SteamUser from 'steam-user'
import { OfflineStore } from './stores/OfflineStore'

export class FamiClient extends Vegapunk {
	public constructor() {
		super()

		container.steam = new EventEmitter()
		Object.assign(this, { sessions: new Map<string, SessionContext>() })
	}

	public override async start() {
		await super.start()
		await sleepUntil(() => typeof this.config !== 'undefined')

		this.config.users.forEach((user) => this.login(user))
	}

	public override async login(user: UserContext) {
		let session = this.sessions.get(user.username)
		if (typeof session === 'object') {
			if (session.isLogged) {
				session.isLogged = false
				session.client.logOff()
			}

			clearTimeout(session.timeout)
			this.sessions.delete(user.username)
		}

		const path = `${process.cwd()}/sessions/${user.username}/session.json`
		const store = new OfflineStore<SessionContext>({ path })
		await store.readFile()

		const uniq = VegapunkSnowflake.generate({ processId: BigInt(this.sessions.size) })
		this.sessions.set(user.username, {
			id: `${uniq}`,
			client: new SteamUser({
				dataDirectory: store.dir,
				renewRefreshTokens: true,
				autoRelogin: false,
			}),
			store,
			ownedGameList: [],
			bannedGameIds: [],
			...user,
			...store.data,
		})

		process.nextTick(() => {
			session = this.sessions.get(user.username)

			container.stores.get('listeners').forEach((ev) => {
				if (ev.emitter !== container.steam) return
				session.client.on(ev.event as any, (...args: unknown[]) => {
					container.steam.emit(ev.event, session, ...args)
				})
			})

			session.timeout = setTimeout(() => this.login(user), 60_000)
			if (typeof session.refreshToken === 'string') {
				session.client.logOn({ refreshToken: session.refreshToken })
			} else {
				session.client.logOn({ accountName: session.username, password: session.password })
			}
		})
	}

	public override isSessionExpired(user: SessionContext) {
		const session = this.sessions.get(user.username)
		if (!session) return true
		if (user.id !== session.id) return true
		if (!user.isLogged || !session.isLogged) return true
		return false
	}
}

export interface ConfigContext {
	refreshGames: number
	fetchFreeGames: boolean
	skipBannedGames: boolean
	whitelistGameIds: number[]
	blacklistGameIds: number[]
	users: UserContext[]
}

export interface UserContext {
	fetchFreeGames: boolean

	username: string
	password: string
	secret: string
	refreshToken: string
	whitelistGameIds: number[]
	blacklistGameIds: number[]
}

export interface SessionContext extends UserContext {
	id: string
	client: SteamUser
	store: OfflineStore<SessionContext>
	timeout: NodeJS.Timeout

	isLogged?: boolean
	isSteamGuard?: boolean
	ownedGameList: GameContext[]
	bannedGameIds: number[]

	lastPage?: number
	lastLoop?: number
	forceRequest?: boolean
	freeGameList?: GameContext[]
	freeGameLength?: number
	freeGameIds?: number[]
}

export interface GameContext {
	name: string
	appid: number
}

declare module '@vegapunk/core' {
	interface Vegapunk {
		readonly config: ConfigContext
		readonly sessions: Map<string, SessionContext>
		login(user: UserContext): Promise<void>
		isSessionExpired(user: SessionContext): boolean
	}

	interface Container {
		steam: EventEmitter
	}
}
