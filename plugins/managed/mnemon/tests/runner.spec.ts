import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findMnemonCommand } from '../src/runner.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mnemon-runner-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('Mnemon CLI discovery', () => {
  it('keeps an explicit cliPath first and expands Windows home syntax', () => {
    expect(findMnemonCommand(
      { cliPath: '~\\go\\bin\\mnemon.exe' },
      { platform: 'win32', env: {}, home: 'C:\\Users\\alice', isExecutable: () => false },
    )).toBe('C:\\Users\\alice\\go\\bin\\mnemon.exe')
  })

  it('reads Windows environment names case-insensitively and accepts only mnemon.exe from PATH', () => {
    const probes: string[] = []
    const command = findMnemonCommand({}, {
      platform: 'win32',
      env: { Path: 'C:\\tools' },
      home: 'C:\\Users\\alice',
      isExecutable: (path) => {
        probes.push(path)
        return path.endsWith('mnemon.cmd')
      },
    })

    expect(command).toBeUndefined()
    expect(probes).toContain('C:\\tools\\mnemon.exe')
    expect(probes.every(path => !path.endsWith('.cmd'))).toBe(true)
  })

  it.each([
    {
      name: 'GOBIN',
      env: { GOBIN: 'D:\\go-bin', GOPATH: 'E:\\go-work' },
      expected: 'D:\\go-bin\\mnemon.exe',
    },
    {
      name: 'the first GOPATH entry',
      env: { GOPATH: 'D:\\go-work;E:\\other-work' },
      expected: 'D:\\go-work\\bin\\mnemon.exe',
    },
    {
      name: 'the default user Go bin',
      env: {},
      expected: 'C:\\Users\\alice\\go\\bin\\mnemon.exe',
    },
    {
      name: 'LOCALAPPDATA programs',
      env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' },
      expected: 'C:\\Users\\alice\\AppData\\Local\\Programs\\mnemon\\mnemon.exe',
    },
    {
      name: 'Program Files',
      env: { ProgramFiles: 'C:\\Program Files' },
      expected: 'C:\\Program Files\\mnemon\\mnemon.exe',
    },
  ])('discovers a Windows binary from $name', ({ env, expected }) => {
    expect(findMnemonCommand({}, {
      platform: 'win32',
      env,
      home: 'C:\\Users\\alice',
      isExecutable: path => path === expected,
    })).toBe(expected)
  })

  it('rejects a directory and accepts a regular .exe file on Windows', () => {
    const root = temporaryDirectory()
    const directory = join(root, 'directory.exe')
    const command = join(root, 'mnemon.exe')
    mkdirSync(directory)
    writeFileSync(command, 'fixture', 'utf8')

    expect(findMnemonCommand({}, {
      platform: 'win32', env: { MNEMON_CLI_PATH: directory }, home: root,
    })).toBeUndefined()
    expect(findMnemonCommand({}, {
      platform: 'win32', env: { MNEMON_CLI_PATH: command }, home: root,
    })).toBe(command)
  })

  it('uses native Windows path joining for discovery candidates', () => {
    const expected = win32.join('C:\\Users\\alice', 'go', 'bin', 'mnemon.exe')
    expect(findMnemonCommand({}, {
      platform: 'win32', env: {}, home: 'C:\\Users\\alice', isExecutable: path => path === expected,
    })).toBe(expected)
  })
})
