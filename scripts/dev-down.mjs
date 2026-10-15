// Stops the local stack. Pass --volumes to also delete its data.
import { run } from './lib.mjs'

const args = ['kube', 'down']
if (process.argv.includes('--volumes')) args.push('--force')
for (const file of ['infra/dev.yaml', 'infra/deps.yaml']) run('podman', [...args, file], { allowFailure: true })
