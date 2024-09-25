import { parseJsonc } from '@vegapunk/utilities'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DataStore, DataStoreOptions } from './internal/DataStore'

export class OfflineStore<T> extends DataStore<T> {
	public constructor(options: OfflineStoreOptions<T>) {
		super(options)
		this.path = options.path
		Object.assign(this, { dir: dirname(options.path) })
	}

	protected async _readFile() {
		return parseJsonc<T>(await readFile(this.path, 'utf8'))
	}

	protected async _writeFile() {
		await writeFile(this.path, JSON.stringify(this.data))
	}

	protected async _init() {
		await access(this.dir).catch(() => mkdir(this.dir, { recursive: true }))
		await access(this.path).catch(() => writeFile(this.path, JSON.stringify(this.options.init)))
	}

	private path: string
}

export type OfflineStoreOptions<T> = DataStoreOptions<T> & {
	path: string
}
