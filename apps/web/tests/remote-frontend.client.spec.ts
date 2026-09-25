// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getBrowserRemoteAccessToken,
  setBrowserRemoteAccessToken,
  WebRemoteAuthClient,
} from '@deepseek-ai/dsh-client-connection/client'
import { prepareRemoteFrontend } from '../src/remote-frontend.ts'

afterEach(() => {
  globalThis.dispatchEvent(new Event('pagehide'))
  setBrowserRemoteAccessToken(undefined)
  localStorage.clear()
  document.documentElement.removeAttribute('data-dsh-remote-scope')
  document.body.innerHTML = '<div id="root"></div>'
  history.replaceState({}, '', '/')
  vi.restoreAllMocks()
})

describe('browser remote Frontend bootstrap', () => {
  it('exchanges a stored device credential before publishing the bearer', async () => {
    history.replaceState({}, '', '/?dsh-deployment-role=frontend')
    localStorage.setItem(`dsh.remote-device.v1:${location.origin}`, JSON.stringify({
      deviceId: 'device-1', credential: 'durable-1', scope: 'pocket',
    }))
    const exchange = vi.spyOn(WebRemoteAuthClient.prototype, 'exchange').mockResolvedValue({
      deviceId: 'device-1', deviceName: 'Phone', scope: 'pocket',
      accessToken: 'access-1', expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })

    await prepareRemoteFrontend()

    expect(exchange).toHaveBeenCalledWith('durable-1')
    expect(getBrowserRemoteAccessToken()).toBe('access-1')
    expect(document.documentElement.dataset.dshRemoteScope).toBe('pocket')
  })

  it('renders pairing, redeems once, and stores only the durable credential', async () => {
    history.replaceState({}, '', '/?dsh-deployment-role=frontend')
    vi.spyOn(WebRemoteAuthClient.prototype, 'redeemPairing').mockResolvedValue({
      deviceId: 'device-2', credential: 'durable-2', scope: 'cockpit',
    })
    vi.spyOn(WebRemoteAuthClient.prototype, 'exchange').mockResolvedValue({
      deviceId: 'device-2', deviceName: 'Browser', scope: 'cockpit',
      accessToken: 'access-2', expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })

    const prepared = prepareRemoteFrontend()
    await vi.waitFor(() => { expect(document.querySelector('form')).not.toBeNull() })
    const form = document.querySelector('form') as HTMLFormElement
    ;(form.elements.namedItem('deviceName') as HTMLInputElement).value = 'Browser'
    ;(form.elements.namedItem('code') as HTMLInputElement).value = '12345678'
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await prepared

    expect(getBrowserRemoteAccessToken()).toBe('access-2')
    expect(localStorage.getItem(`dsh.remote-device.v1:${location.origin}`)).toContain('durable-2')
    expect(localStorage.getItem(`dsh.remote-device.v1:${location.origin}`)).not.toContain('access-2')
  })

  it('skips the browser credential flow for the Electron Frontend', async () => {
    history.replaceState({}, '', '/?dsh-deployment-role=frontend&dsh-desktop-platform=darwin')
    const exchange = vi.spyOn(WebRemoteAuthClient.prototype, 'exchange')
    await prepareRemoteFrontend()
    expect(exchange).not.toHaveBeenCalled()
  })
})
