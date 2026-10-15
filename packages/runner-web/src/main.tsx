import { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api } from './api.js'
import { BoardPage } from './pages/BoardPage.js'
import { HomePage } from './pages/HomePage.js'
import { MyRunsPage } from './pages/MyRunsPage.js'
import { lastSeen, NotificationsPage } from './pages/NotificationsPage.js'
import { RequestPage } from './pages/RequestPage.js'
import { RunPage } from './pages/RunPage.js'
import { SubmitPage } from './pages/SubmitPage.js'
import { SignIn } from '@speedrunledger/web-ui'
import { Link, useLocation } from './router.js'
import '@speedrunledger/web-ui/style.css'

export interface Me {
  did: string
  handle?: string
}

function App() {
  const location = useLocation()
  const [me, setMe] = useState<Me | null | undefined>(undefined)

  const loadMe = useCallback(async () => {
    try {
      const { did } = await api.me()
      const runner = await api.getRunner(did).catch(() => undefined)
      setMe({ did, handle: runner?.actor.handle })
    } catch {
      setMe(null)
    }
  }, [])
  useEffect(() => {
    void loadMe()
  }, [loadMe])

  // How many notifications arrived since the runner last looked.
  const [unread, setUnread] = useState(0)
  const checkUnread = useCallback(() => {
    if (!me) return
    api.listNotifications(me.did).then(
      ({ notifications }) => setUnread(notifications.filter((n) => n.indexedAt > lastSeen()).length),
      () => undefined,
    )
  }, [me])
  useEffect(() => {
    checkUnread()
    const timer = setInterval(checkUnread, 30_000)
    return () => clearInterval(timer)
  }, [checkUnread])

  const loginError = location.searchParams.get('loginError')
  let page
  switch (location.pathname) {
    case '/board':
      page = <BoardPage category={location.searchParams.get('category') ?? ''} variables={location.searchParams.getAll('var')} me={me} />
      break
    case '/run':
      page = <RunPage uri={location.searchParams.get('uri') ?? ''} me={me} share={location.searchParams.get('share') === '1'} />
      break
    case '/submit':
      page = (
        <SubmitPage
          category={location.searchParams.get('category') ?? ''}
          edit={location.searchParams.get('edit') ?? undefined}
          me={me}
        />
      )
      break
    case '/notifications':
      page = <NotificationsPage me={me} onSeen={checkUnread} />
      break
    case '/request':
      page = <RequestPage me={me} />
      break
    case '/me':
      page = <MyRunsPage me={me} />
      break
    default:
      page = <HomePage />
  }

  return (
    <>
      <header className="top">
        <Link href="/" className="brand">
          Speedrun<span>Ledger</span>
        </Link>
        <nav>
          <Link href="/">Games</Link>
          {me && <Link href="/me">My runs</Link>}
          {me && (
            <Link href="/notifications">
              Notifications{unread > 0 && <span className="badge">{unread}</span>}
            </Link>
          )}
          <Link href="/request">Start a community</Link>
        </nav>
        <div className="account">
          {me === undefined ? null : me ? (
            <>
              <span className="who">@{me.handle ?? me.did}</span>
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
          ) : (
            <SignIn />
          )}
        </div>
      </header>
      {loginError && <p className="error banner">Sign-in failed: {loginError}</p>}
      <main>{page}</main>
      <footer>
        Runs live in each runner’s own repo; verdicts live in each community’s repo. Boards are computed from public records.
      </footer>
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
