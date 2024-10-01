import { Task } from '@vegapunk/core'
import { ConfigContext } from '../lib/FamiClient'
import { OnlineStore } from '../lib/stores/OnlineStore'

export class UserTask extends Task {
	public constructor(context: Task.LoaderContext) {
		super(context, { delay: 10_000, ref: true })
	}

	public override async start() {
		const client = this.container.client

		await this.onlineStore.readFile()
		Object.assign(client, { config: this.onlineStore.data })

		this.onlineStore.setDelay(client.config.refreshGames)
	}

	public async update() {
		await this.onlineStore.writeFile()
	}

	private readonly onlineStore = new OnlineStore<ConfigContext>({
		owner: process.env.GITHUB_OWNER,
		repo: process.env.GITHUB_REPO,
		path: process.env.GITHUB_PATH,
	})
}
