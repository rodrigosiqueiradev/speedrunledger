export { Link, navigate, useLocation } from '@speedrunledger/web-ui'

export const queueHref = (community: string) => `/queue?${new URLSearchParams({ community })}`
export const reviewHref = (run: string) => `/review?${new URLSearchParams({ uri: run })}`
export const communityHref = (community: string, tab?: string) =>
  `/community?${new URLSearchParams(tab ? { did: community, tab } : { did: community })}`
