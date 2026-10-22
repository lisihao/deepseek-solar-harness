export async function fetchUser(id) {
  await new Promise(resolve => setTimeout(resolve, 5))
  return { id, name: `user-${id}` }
}

export async function userName(id) {
  const user = fetchUser(id)
  return user.name
}
