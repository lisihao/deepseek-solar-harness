/** Sort people by age, youngest first, without changing the input. */
export function sortByAge(people) {
  return [...people].sort((a, b) => a.age > b.age)
}
