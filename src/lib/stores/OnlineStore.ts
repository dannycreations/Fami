import { Octokit } from '@octokit/rest'
import { container } from '@vegapunk/core'
import { parseJsonc, PartialRequired } from '@vegapunk/utilities'
import { dirname } from 'node:path'
import { DataStore, DataStoreOptions } from './internal/DataStore'

export class OnlineStore<T> extends DataStore<T> {
	public constructor(options: OnlineStoreOptions<T>) {
		super(options)
		options.branch ||= 'main'
		Object.assign(this, { dir: dirname(`${options.repo}${options.branch}${options.path}`) })
	}

	protected async _readFile() {
		return this.pull<T>()
	}

	protected async _writeFile() {
		await this.push({ content: JSON.stringify(this.data, null, 2) })
	}

	protected async _init() {
		await this.pull().catch(() => this.writeFile(this.options.init))
	}

	private async pull<T>(options: Partial<PullContext> = {}) {
		options = { ...this.options, ...options }

		try {
			const data = (
				await this.client.repos.getContent({
					owner: options.owner,
					repo: options.repo,
					ref: options.branch,
					path: options.path,
				})
			).data as DataContext

			const key = `${options.branch}/${options.path}`
			this.shaCache.set(key, data.sha)

			const content = Buffer.from(data.content, 'base64').toString()
			return parseJsonc<T>(content)
		} catch (error) {
			if ('response' in error) {
				container.logger.error(error, `Github pull: ${error.response.status} ${error.message}`)
			}
			return null
		}
	}

	private async push(options: PartialRequired<PushContext, 'content'>) {
		options = { ...this.options, ...options }

		try {
			options.content = typeof options.content === 'object' ? JSON.stringify(options.content) : options.content
			options.content = Buffer.from(options.content).toString('base64')

			const key = `${options.branch}/${options.path}`
			let sha = this.shaCache.get(key)
			if (typeof sha === 'undefined') {
				await this.pull(options)
				sha = this.shaCache.get(key)
			}

			const data = (
				await this.client.repos.createOrUpdateFileContents({
					owner: options.owner,
					repo: options.repo,
					ref: options.branch,
					path: options.path,
					content: options.content,
					message: options.message ?? 'from_server',
					sha,
				})
			).data

			sha = data.content.sha
			this.shaCache.set(key, sha)
			return true
		} catch (error) {
			if ('response' in error) {
				container.logger.error(error, `Github push: ${error.response.status} ${error.message}`)
			}
			return false
		}
	}

	private readonly client = new Octokit({ auth: process.env.GITHUB_TOKEN })
	private readonly shaCache = new Map<string, string>()
}

export type OnlineStoreOptions<T> = DataStoreOptions<T> & PullContext

export interface PullContext {
	owner: string
	repo: string
	branch?: string
	path: string
}

export interface PushContext extends PullContext {
	content: string
	message?: string
}

interface DataContext {
	type: 'dir' | 'file' | 'submodule' | 'symlink'
	size: number
	name: string
	path: string
	content?: string
	sha: string
	url: string
	git_url: string | null
	html_url: string | null
	download_url: string | null
	_links: {
		git: string | null
		html: string | null
		self: string
	}
}
