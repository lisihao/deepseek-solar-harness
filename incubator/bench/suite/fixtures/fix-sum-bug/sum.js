export function sum(values) {
  let total = 0
  for (let i = 1; i < values.length; i++) total += values[i]
  return total
}
