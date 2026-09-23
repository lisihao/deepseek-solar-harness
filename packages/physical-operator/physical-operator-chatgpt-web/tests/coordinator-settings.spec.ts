import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebCoordinatorSettings } from '../src/coordinator-settings.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-chatgpt-web-settings-'))
  roots.push(root)
  return root
}

describe('WebCoordinatorSettings', () => {
  it('defaults to direct mode and keeps the endpoint token across reloads and mode changes', () => {
    const root = temporaryRoot()
    const first = new WebCoordinatorSettings(root)

    expect(first.mode).toBe('direct')
    expect(first.mcpPath).toMatch(/^\/mcp\/dsh\/[A-Za-z0-9_-]{43}$/u)

    first.save()
    const tokenPath = join(root, 'coordination.json')
    const saved = JSON.parse(readFileSync(tokenPath, 'utf8')) as {
      readonly version: number
      readonly mode: string
      readonly token: string
    }
    expect(saved).toEqual({ version: 1, mode: 'direct', token: first.mcpPath.slice('/mcp/dsh/'.length) })

    const reloaded = new WebCoordinatorSettings(root)
    expect(reloaded.mode).toBe('direct')
    expect(reloaded.mcpPath).toBe(first.mcpPath)

    reloaded.select('coordinator')
    expect(reloaded.mode).toBe('coordinator')

    const resumed = new WebCoordinatorSettings(root)
    expect(resumed.mode).toBe('coordinator')
    expect(resumed.mcpPath).toBe(first.mcpPath)
  })

  it('fails closed when the persisted document is malformed', () => {
    const root = temporaryRoot()
    writeFileSync(join(root, 'coordination.json'), JSON.stringify({ version: 1, mode: 'direct', token: 'invalid' }))

    expect(() => new WebCoordinatorSettings(root)).toThrow()
  })

  it('restores the previous mode when the settings writer fails', () => {
    const parent = temporaryRoot()
    const root = join(parent, 'root-file')
    writeFileSync(root, 'this path cannot be a settings directory')
    const settings = new WebCoordinatorSettings(root)

    expect(() => { settings.select('coordinator') }).toThrow()
    expect(settings.mode).toBe('direct')
  })
})
