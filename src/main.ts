import 'dotenv/config'

import { container } from '@vegapunk/core'
import { FamiClient } from './lib/FamiClient'

const client = new FamiClient()

async function main() {
	try {
		await client.start()
	} catch (error) {
		container.logger.error(error)
		process.exit(1)
	}
}
main().catch(container.logger.error.bind(container.logger))
