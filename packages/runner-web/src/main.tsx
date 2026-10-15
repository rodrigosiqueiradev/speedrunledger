import { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api } from './api.js'
import { BoardPage } from './pages/BoardPage.js'
import { HomePage } from './pages/HomePage.js'
import { MyRunsPage } from './pages/MyRunsPage.js'
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

  const loginError = location.searchParams.get('loginError')
  let page
  switch (location.pathname) {
    case '/board':
      page = <BoardPage category={location.searchParams.get('category') ?? ''} variables={location.searchParams.getAll('var')} me={me} />
      break
    case '/run':
      page = <RunPage uri={location.searchParams.get('uri') ?? ''} me={me} />
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
