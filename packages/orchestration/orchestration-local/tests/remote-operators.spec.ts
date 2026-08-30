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

  it('derives remote capacity from cluster membership and rejects a second manual catalog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-operators-cluster-'))
    await writeFile(join(root, 'cluster.json'), JSON.stringify({
      version: 1,
      nodeId: 'book',
      members: [
        {
          id: 'book', label: 'MacBook', endpoint: 'http://127.0.0.1:13080',
          remoteExecution: {
            enabled: true,
            repositories: [{ repository: 'github.com/lisihao/project', source: '/srv/git/project' }],
          },
        },
        {
          id: 'mini', label: 'Mac mini', endpoint: 'http://100.114.161.62:13080',
          remoteExecution: {
            enabled: true, pollIntervalMs: 300,
            repositories: [{ repository: 'git@github.com:lisihao/project.git', source: '/srv/git/project' }],
          },
        },
        {
          id: 'observer', label: 'Observer', endpoint: 'http://observer.example',
          remoteExecution: { enabled: false, repositories: [] },
        },
      ],
    }))
    expect(readRemoteOperatorCatalog(root)).toEqual([{
      id: 'mini', label: 'Mac mini', endpoint: 'http://100.114.161.62:13080/', pollIntervalMs: 300,
    }])
    await writeFile(join(root, 'remote-operators.json'), JSON.stringify({ version: 1, servers: [] }))
    expect(() => readRemoteOperatorCatalog(root)).toThrow('cannot both own capacity')
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
