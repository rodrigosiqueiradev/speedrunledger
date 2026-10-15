import { readConfig } from './config.js'
import { CommunityServiceServer } from './server.js'

const main = async () => {
  const server = new CommunityServiceServer(readConfig())
  await server.start()
  server.service.logger.info({ url: server.url, did: server.config.serviceDid }, 'community service listening')
  const shutdown = async () => {
    await server.destroy()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
