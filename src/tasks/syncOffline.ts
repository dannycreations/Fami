import { Task } from '@vegapunk/core'

export class UserTask extends Task {
	public constructor(context: Task.LoaderContext) {
		super(context, { delay: 60_000 * 10, ref: true })
	}

	public override start() {
		const { sessions } = this.container.client
		;[...sessions.values()].forEach((r) => r.store.setDelay(this.options.delay))
	}

	public async update() {
		const { sessions } = this.container.client
		await Promise.all([...sessions.values()].map((r) => r.store.writeFile()))
	}
}
