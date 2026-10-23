/** Return [0, 1, ..., n - 1]. */
export function range(n) {
  const out = []
  for (let i = 1; i < n; i++) out.push(i)
  return out
}
