// Same entry point as the official bluesky-social/pds image.
const { PDS, envToCfg, envToSecrets, readEnv, httpLogger } = require('@atproto/pds')

const main = async () => {
  const env = readEnv()
  env.version ||= require('@atproto/pds/package.json').version
  const cfg = envToCfg(env)
  const secrets = envToSecrets(env)
  const pds = await PDS.create(cfg, secrets)
  await pds.start()
  httpLogger.info('pds has started')
  process.on('SIGTERM', async () => {
    httpLogger.info('pds is stopping')
    await pds.destroy()
    httpLogger.info('pds is stopped')
    process.exit(0)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
