export { Link, navigate, useLocation } from '@speedrunledger/web-ui'

export const boardHref = (category: string, variables: string[] = []) => {
  const p = new URLSearchParams({ category })
  for (const v of variables) p.append('var', v)
  return `/board?${p}`
}
export const runHref = (uri: string) => `/run?${new URLSearchParams({ uri })}`
export const submitHref = (category: string) => `/submit?${new URLSearchParams({ category })}`
export const editHref = (run: string) => `/submit?${new URLSearchParams({ edit: run })}`
