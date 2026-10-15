import { useState } from 'react'

const statusText: Record<string, string> = {
  pending: 'Waiting for review',
  verified: 'Verified',
  rejected: 'Rejected',
  changesRequested: 'Changes requested',
  invalid: 'Not accepted by the category',
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`status ${status}`}>{statusText[status] ?? status}</span>
}

/** Starts atproto OAuth sign-in for a handle through the app's /api/login. */
export function SignIn() {
  const [handle, setHandle] = useState('')
  return (
    <form
      className="signin"
      onSubmit={(e) => {
        e.preventDefault()
        window.location.href = `/api/login?${new URLSearchParams({ handle })}`
      }}
    >
      <input
        aria-label="Your handle"
        placeholder="you.bsky.social"
        value={handle}
        onChange={(e) => setHandle(e.target.value)}
        autoComplete="username"
      />
      <button type="submit">Sign in</button>
    </form>
  )
}
