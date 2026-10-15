// Stops the local stack. Pass --volumes to also delete its data.
import { run } from './lib.mjs'

const args = ['kube', 'down']
if (process.argv.includes('--volumes')) args.push('--force')
run('podman', [...args, 'infra/dev.yaml'], { allowFailure: true })
