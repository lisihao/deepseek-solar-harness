import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('browser bundle platform boundary', () => {
  const clientSources = () => {
    const directory = new URL('../src/client/', import.meta.url)
    const directoryPath = fileURLToPath(directory)
    return readdirSync(directory, { recursive: true })
      .filter(path => /\.[jt]sx?$/.test(String(path)))
      .map(path => ({ path: String(path), source: readFileSync(join(directoryPath, String(path)), 'utf8') }))
  }

  it('routes every Client parent import through the shared contract', () => {
    const violations = clientSources()
      .flatMap(({ path, source }) => {
        return [...source.matchAll(/(?:from|import)\s*['"](\.\.\/[^'"]+)['"]/gu)]
          .map(match => `${path}: ${match[1]}`)
      })
      .filter(imported => !imported.endsWith('../shared/contracts.ts'))
    expect(violations).toEqual([])
  })

  it('keeps the shared browser contract free of Node runtime imports', () => {
    const contract = readFileSync(new URL('../src/shared/contracts.ts', import.meta.url), 'utf8')
    expect(contract).not.toMatch(/from\s*['"]node:/u)
  })

  it('delegates deployment URLs and transport to the host connection', () => {
    const forbidden = /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|['"]\/(?:api|m\/api|plugins|assets)(?:\/|['"])/gu
    const violations = clientSources().flatMap(({ path, source }) => {
      return [...source.matchAll(forbidden)].map(match => `${path}: ${match[0]}`)
    })
    expect(violations).toEqual([])
  })
})
