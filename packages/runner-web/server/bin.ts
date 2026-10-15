import { RunnerWeb } from './app.js'
import { readConfig } from './config.js'

const main = async () => {
  const config = readConfig()
  const web = new RunnerWeb(config)
  await web.start()
  console.log(`runner app on ${config.publicUrl}`)
  const shutdown = async () => {
    await web.destroy()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
