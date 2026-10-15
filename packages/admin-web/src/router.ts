export { Link, navigate, useLocation } from '@speedrunledger/web-ui'

export const communityHref = (did: string) => `/community?${new URLSearchParams({ did })}`
