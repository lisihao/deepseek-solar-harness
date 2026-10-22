export function parseHeader(line) {
  const [name, ...rest] = line.split(':')
  return { name: name.trim(), value: rest.join(':').trim() }
}
