// Builds SpeedrunLedger images with Podman: node scripts/podman-build.mjs [image...]
//
// Behind an HTTPS proxy that re-signs TLS, set HTTPS_PROXY and
// BUILD_CA_BUNDLE (a PEM file); both are passed to the build only and never
// end up in an image.
import { pathToFileURL } from 'node:url'
import { run } from './lib.mjs'

export const images = ['plc', 'pds', 'indexer', 'appview', 'community-service', 'runner-web', 'moderator-web']

export function buildImage(name) {
  const args = ['build', '--network=host']
  if (process.env.HTTPS_PROXY) {
    args.push('--build-arg', `HTTPS_PROXY=${process.env.HTTPS_PROXY}`, '--build-arg', `https_proxy=${process.env.HTTPS_PROXY}`)
  }
  if (process.env.BUILD_CA_BUNDLE) {
    args.push('-v', `${process.env.BUILD_CA_BUNDLE}:/etc/build-ca.pem:ro`,
      '--build-arg', 'NODE_EXTRA_CA_CERTS=/etc/build-ca.pem',
      '--build-arg', 'npm_config_cafile=/etc/build-ca.pem')
  }
  if (name === 'plc' || name === 'pds') {
    args.push('-f', `infra/${name}/Containerfile`)
  } else if (images.includes(name)) {
    args.push('-f', 'infra/service.Containerfile', '--build-arg', `PACKAGE=${name}`)
  } else {
    console.error(`unknown image: ${name}`)
    process.exit(1)
  }
  args.push('-t', `localhost/speedrunledger/${name}:dev`, name === 'plc' || name === 'pds' ? `infra/${name}` : '.')
  console.log(`==> building localhost/speedrunledger/${name}`)
  run('podman', args)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const targets = process.argv.slice(2)
  for (const t of targets.length ? targets : images) buildImage(t)
}
