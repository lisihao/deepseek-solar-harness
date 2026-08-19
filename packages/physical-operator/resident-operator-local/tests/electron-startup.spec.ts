import { describe, expect, it } from 'vitest'
import { residentDaemonEnvironment } from '../src/client.ts'
import { clearElectronRunAsNode } from '../src/startup.ts'

describe('Resident daemon Electron bootstrap', () => {
  it('adds RunAsNode only to the Electron child environment', () => {
    const host = { PATH: '/usr/bin', electron_run_as_node: 'stale' }
    const child = residentDaemonEnvironment(host, '43.4.0')

    expect(host).toEqual({ PATH: '/usr/bin', electron_run_as_node: 'stale' })
    expect(child).toEqual({ PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' })
  })

  it('removes inherited RunAsNode in ordinary Node and daemon product environments', () => {
    const child = residentDaemonEnvironment({ ELECTRON_RUN_AS_NODE: '1', PATH: '/bin' }, undefined)
    expect(child).toEqual({ PATH: '/bin' })

    const daemon = { Electron_Run_As_Node: '1', PATH: '/usr/bin' }
    clearElectronRunAsNode(daemon)
    expect(daemon).toEqual({ PATH: '/usr/bin' })
  })
})
