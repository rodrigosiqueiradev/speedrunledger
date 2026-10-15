import { SignIn } from '@speedrunledger/web-ui'
import '@speedrunledger/web-ui/style.css'
import { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { actorLabel, api, type WhoAmI } from './api.js'
import { CommunitiesPage } from './pages/CommunitiesPage.js'
import { CommunityPage } from './pages/CommunityPage.js'
import { JobsPage } from './pages/JobsPage.js'
import { RequestsPage } from './pages/RequestsPage.js'
import { SetupPage } from './pages/SetupPage.js'
import { SysadminsPage } from './pages/SysadminsPage.js'
import { Link, useLocation } from './router.js'
import './style.css'

const NAV = [
  ['/', 'Requests'],
  ['/communities', 'Communities'],
  ['/sysadmins', 'Sysadmins'],
  ['/jobs', 'Jobs'],
] as const

function App() {
  const location = useLocation()
  const [me, setMe] = useState<WhoAmI | null | undefined>(undefined)
  const load = useCallback(() => {
    api.whoami().then(setMe, () => setMe(null))
  }, [])
  useEffect(load, [load])

  const loginError = location.searchParams.get('loginError')
  let page
  if (me === null) {
    page = (
      <section className="narrow">
        <h1>Admin</h1>
        <p>
          Sign in with your own atproto account to run SpeedrunLedger as a sysadmin: answer community requests, create
          communities, and step in when a community needs it. Every change is a public record that names you.
        </p>
        <SignIn />
      </section>
    )
  } else if (me === undefined) {
    page = <p className="muted">Loading…</p>
  } else if (!me.initialized) {
    page = <SetupPage me={me} done={load} />
  } else if (!me.sysadmin) {
    page = (
      <section className="narrow">
        <h1>Not a sysadmin</h1>
        <p>
          {actorLabel(me)} is not listed as a SpeedrunLedger sysadmin, so there is nothing for you here. A sysadmin can add
          you; until then, sign out and sign in with a sysadmin account.
        </p>
      </section>
    )
  } else {
    switch (location.pathname) {
      case '/communities':
        page = <CommunitiesPage />
        break
      case '/community':
        page = <CommunityPage did={location.searchParams.get('did') ?? ''} />
        break
      case '/sysadmins':
        page = <SysadminsPage me={me} />
        break
      case '/jobs':
        page = <JobsPage />
        break
      default:
        page = <RequestsPage />
    }
  }

  const section = location.pathname === '/community' ? '/communities' : location.pathname
  return (
    <>
      <header className="top">
        <Link href="/" className="brand">
          Speedrun<span>Ledger</span> <small className="muted">admin</small>
        </Link>
        {me?.sysadmin && (
          <nav>
            {NAV.map(([href, label]) => (
              <Link key={href} href={href} aria-current={section === href ? 'page' : undefined}>
                {label}
              </Link>
            ))}
          </nav>
        )}
        <div className="account">
          {me && (
            <>
              <span className="who">{actorLabel(me)}</span>
              <button
                className="link"
                onClick={async () => {
                  await api.logout()
                  setMe(null)
                }}
              >
                Sign out
              </button>
            </>
          )}
        </div>
      </header>
      {loginError && <p className="error banner">Sign-in failed: {loginError}</p>}
      <main>{page}</main>
      <footer>Sysadmins create communities and step in when one has no moderators; they never touch verdicts or boards.</footer>
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
