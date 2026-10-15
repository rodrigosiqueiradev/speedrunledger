import { createServer } from 'node:net'
import type { Page } from 'playwright-core'

/** Where Chromium lives for browser tests; preinstalled at this path in CI and the cloud sandbox. */
export const chromiumPath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium'

/** A free TCP port on the loopback interface. */
export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })

/**
 * Signs in to one of our web apps through the local PDS's own OAuth pages:
 * the app's handle form, the PDS's password page, then its consent page.
 */
export async function signInWithOAuth(page: Page, opts: { appUrl: string; pdsUrl: string; handle: string; password: string }) {
  await page.goto(opts.appUrl)
  await page.fill('input[aria-label="Your handle"]', opts.handle)
  await page.click('button:has-text("Sign in")')
  await page.waitForURL((url) => url.port === new URL(opts.pdsUrl).port)
  await page.fill('input[name=password]', opts.password)
  await page.click('button[type=submit]')
  await page.click('button:has-text("Authorize")')
  await page.waitForURL((url) => url.origin === opts.appUrl)
  await page.getByText(opts.handle).first().waitFor()
}
