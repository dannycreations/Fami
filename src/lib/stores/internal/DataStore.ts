import { _ } from '@vegapunk/utilities'

export abstract class DataStore<T extends DataStoreContext> {
	public readonly dir: string
	public readonly data = {} as T

	public constructor(protected options: DataStoreOptions<T>) {
		this.setDelay(options.delay)
		Object.assign(this, { oldData: '' })
		Object.assign(this.data, { __updatedAt: 0 })
	}

	protected abstract _init(): Promise<void>
	protected abstract _readFile(): Promise<T>
	protected abstract _writeFile(): Promise<void>

	public setDelay(delay: number) {
		if (typeof delay !== 'number') delay = 0
		this.options.delay = Math.min(Math.max(Math.trunc(delay), 0), 2147483647)
		return true
	}

	public clearData() {
		Object.assign(this, { data: {} })
		return true
	}

	public async readFile() {
		await this.init()

		const json = await this._readFile()
		Object.assign(this.data, _.defaultsDeep({}, json, this.data))
		return true
	}

	public async writeFile(json: Partial<T> = this.data, force = false) {
		await this.init()

		Object.assign(this.data, _.defaultsDeep({}, json, this.data))

		const newData = JSON.stringify(this.data)
		if (Buffer.from(newData).equals(Buffer.from(this.oldData))) return false
		if (this.data.__updatedAt + this.options.delay > Date.now() && !force) return false
		this.data.__updatedAt = Date.now()

		await this._writeFile()
		this.oldData = JSON.stringify(this.data)
		return true
	}

	private async init() {
		if (this.lockInit) return
		this.lockInit = true

		this.options.init = { ...this.options.init }
		await this._init()
		this.options.init = undefined
	}

	private oldData: string
	private lockInit: boolean
}

export interface DataStoreOptions<T> {
	delay?: number
	init?: T
}

export interface DataStoreContext {
	__updatedAt?: number
}
