export { Link, navigate, useLocation } from '@speedrunledger/web-ui'

export const queueHref = (community: string) => `/queue?${new URLSearchParams({ community })}`
export const reviewHref = (run: string) => `/review?${new URLSearchParams({ uri: run })}`
