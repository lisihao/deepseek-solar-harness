import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRemoteOperatorCatalog } from '../src/remote-operators.ts'

describe('remote operator catalog', () => {
  it('loads multiple independently addressable Servers and normalizes endpoints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-operators-'))
    await writeFile(join(root, 'remote-operators.json'), JSON.stringify({
      version: 1,
      servers: [
        { id: 'mini', label: 'Mac mini', endpoint: 'http://127.0.0.1:13300' },
        { id: 'lab', label: 'Lab', endpoint: 'https://lab.example/dsh', pollIntervalMs: 500 },
      ],
    }))
    expect(readRemoteOperatorCatalog(root)).toEqual([
      { id: 'mini', label: 'Mac mini', endpoint: 'http://127.0.0.1:13300/' },
      { id: 'lab', label: 'Lab', endpoint: 'https://lab.example/dsh', pollIntervalMs: 500 },
    ])
  })

  it('fails loud for ambiguous or unsupported catalogs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-operators-invalid-'))
    await writeFile(join(root, 'remote-operators.json'), JSON.stringify({
      version: 1,
      servers: [
        { id: 'mini', label: 'Mac mini', endpoint: 'ssh://mini' },
        { id: 'mini', label: 'Duplicate', endpoint: 'https://mini.example' },
      ],
    }))
    expect(() => readRemoteOperatorCatalog(root)).toThrow('must use http or https')
    await writeFile(join(root, 'remote-operators.json'), JSON.stringify({ version: 2, servers: [] }))
    expect(() => readRemoteOperatorCatalog(root)).toThrow('version must be 1')
    await writeFile(join(root, 'remote-operators.json'), JSON.stringify({
      version: 1, servers: [{ id: 'mini', label: 'Mac mini', endpoint: 'https://mini.example', accessToken: 'secret' }],
    }))
    expect(() => readRemoteOperatorCatalog(root)).toThrow('cannot persist accessToken')
  })
})
