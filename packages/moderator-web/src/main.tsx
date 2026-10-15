import { SignIn } from '@speedrunledger/web-ui'
import '@speedrunledger/web-ui/style.css'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api } from './api.js'
import { HomePage } from './pages/HomePage.js'
import { QueuePage } from './pages/QueuePage.js'
import { ReviewPage } from './pages/ReviewPage.js'
import { Link, useLocation } from './router.js'
import './style.css'

export interface Me {
  did: string
  handle?: string
}

function App() {
  const location = useLocation()
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  useEffect(() => {
    api.me().then(
      async ({ did }) => {
        const actor = await api.getRunner(did).catch(() => undefined)
        setMe({ did, handle: actor?.actor.handle })
      },
      () => setMe(null),
    )
  }, [])

  const loginError = location.searchParams.get('loginError')
  let page
  if (me === null) {
    page = (
      <section className="narrow">
        <h1>Moderation</h1>
        <p>
          Sign in with your own atproto account to review runs for the communities you moderate. Verdicts are written into
          the community’s repo by the community service, with your account named as the reviewer.
        </p>
        <SignIn />
      </section>
    )
  } else if (me === undefined) {
    page = <p className="muted">Loading…</p>
  } else {
    switch (location.pathname) {
      case '/queue':
        page = <QueuePage community={location.searchParams.get('community') ?? ''} />
        break
      case '/review':
        page = <ReviewPage uri={location.searchParams.get('uri') ?? ''} me={me} />
        break
      default:
        page = <HomePage me={me} />
    }
  }

  return (
    <>
      <header className="top">
        <Link href="/" className="brand">
          Speedrun<span>Ledger</span> <small className="muted">moderation</small>
        </Link>
        <div className="account">
          {me && (
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
          )}
        </div>
      </header>
      {loginError && <p className="error banner">Sign-in failed: {loginError}</p>}
      <main>{page}</main>
      <footer>Every verdict is a public record in the community’s repo that names its reviewer.</footer>
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
