/** The SSH provider keeps project inspection separate from confirmed preparation. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { GOUZI_AGENT_RESULT_PREFIX } from '../src/gouzi-agent.ts'
import { RemoteGouziHosts } from '../src/gouzi-remote.ts'
import { SYSTEM_SSH, sshExec } from '../src/gouzi-ssh.ts'

vi.mock('../src/gouzi-ssh.ts', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/gouzi-ssh.ts')>(), sshExec: vi.fn() }))

describe('remote directory operations', () => {
  it('sends distinct resolve and prepare operations and surfaces the remote initialization failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gouzi-remote-ops-'))
    writeFileSync(join(root, 'hosts.json'), JSON.stringify({ version: 1, hosts: [{ hostId: 'ssh-test', label: 'test', address: 'example.invalid', port: 22, user: 'test', appVersion: '3.36.0', addedAt: '2026-10-06' }], forwards: {} }))
    const hosts = new RemoteGouziHosts({ root, binaries: SYSTEM_SSH })
    try {
      const project = { projectId: 'project-test', source: '/work/plain dir' }
      vi.mocked(sshExec).mockResolvedValueOnce(`${GOUZI_AGENT_RESULT_PREFIX}${JSON.stringify({ ok: true, value: project })}\n`)
      expect(await hosts.resolveRepository('ssh-test', project.source)).toEqual(project)
      expect(vi.mocked(sshExec).mock.calls[0]?.[2]).toContain('resolve --path')
      vi.mocked(sshExec).mockResolvedValueOnce(`${GOUZI_AGENT_RESULT_PREFIX}${JSON.stringify({ ok: false, message: 'git init failed: permission denied' })}\n`)
      await expect(hosts.prepareRepository('ssh-test', project.source)).rejects.toThrow('git init failed: permission denied')
      expect(vi.mocked(sshExec).mock.calls[1]?.[2]).toContain('prepare --path')
      vi.mocked(sshExec).mockResolvedValueOnce(`${GOUZI_AGENT_RESULT_PREFIX}${JSON.stringify({ ok: false, message: 'not a directory', code: 'ENOTDIR' })}\n`)
      await expect(hosts.resolveRepository('ssh-test', '/work/file')).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      hosts.dispose()
      rmSync(root, { recursive: true, force: true })
      vi.clearAllMocks()
    }
  })
})
