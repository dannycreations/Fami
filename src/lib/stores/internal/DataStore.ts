import { _ } from '@vegapunk/utilities'

const MinStoreDelay = 1000
const MaxStoreDelay = 2147483647

export abstract class DataStore<T extends DataStoreContext> {
	public readonly dir: string
	public readonly data = {} as T

	public constructor(protected options: DataStoreOptions<T>) {
		Object.assign(this, { _oldData: '' })
		Object.assign(this.data, { __updatedAt: 0 })
		Object.assign(options, { init: { ...options.init } })
		this.setDelay(options.delay)
	}

	protected abstract _init(): Promise<void>
	protected abstract _readFile(): Promise<T>
	protected abstract _writeFile(): Promise<void>

	public setDelay(delay: number) {
		delay = typeof delay === 'number' ? delay : MinStoreDelay
		this._delay = Math.min(Math.max(Math.trunc(delay), MinStoreDelay), MaxStoreDelay)
	}

	public clearData() {
		Object.assign(this, { data: {} })
	}

	public async readFile() {
		await this.init()

		const json = await this._readFile()
		Object.assign(this.data, _.defaultsDeep({}, json, this.data))
	}

	public async writeFile(json: Partial<T> = this.data, isForce = false) {
		await this.init()

		Object.assign(this.data, _.defaultsDeep({}, json, this.data))

		const isWaiting = this.data.__updatedAt + this._delay > Date.now()
		if (isWaiting && !isForce) return

		const newData = JSON.stringify(this.data)
		const isEqual = Buffer.from(newData).equals(Buffer.from(this._oldData))
		if (isWaiting && !isForce && isEqual) return

		this.data.__updatedAt = Date.now()
		await this._writeFile()
		this._oldData = JSON.stringify(this.data)
	}

	private async init() {
		if (this._lockInit) return
		this._lockInit = true

		await this._init()
	}

	private _delay: number
	private _oldData: string
	private _lockInit: boolean
}

export interface DataStoreOptions<T> {
	readonly delay?: number
	readonly init?: T
}

export interface DataStoreContext {
	__updatedAt?: number
}
