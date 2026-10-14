import { readConfig } from './config.js'
import { IndexerService } from './service.js'

const main = async () => {
  const service = IndexerService.create(readConfig())
  await service.migrate()
  await service.start()
  const shutdown = async () => {
    service.logger.info('indexer stopping')
    await service.destroy()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
