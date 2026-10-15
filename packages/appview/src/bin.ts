import { AppViewServer, readConfig } from './server.js'

const main = async () => {
  const server = new AppViewServer(readConfig())
  await server.start()
  console.log(`appview listening on ${server.url}`)
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
