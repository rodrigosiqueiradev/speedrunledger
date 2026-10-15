// Local did:plc directory. Uses Postgres when DATABASE_URL is set so DIDs
// survive restarts; otherwise keeps everything in memory.
const { PlcServer, Database } = require('@did-plc/server')

const main = async () => {
  const port = Number(process.env.PLC_PORT || 2582)
  let db
  if (process.env.DATABASE_URL) {
    db = Database.postgres({
      url: process.env.DATABASE_URL,
      schema: process.env.DATABASE_SCHEMA || 'plc',
    })
    await db.migrateToLatestOrThrow()
  } else {
    db = Database.mock()
  }
  const server = PlcServer.create({ db, port })
  await server.start()
  console.log(`plc listening on ${port}`)
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
