import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeAtomic } from '../src/atomic.ts'

const state = vi.hoisted(() => ({
  renameAttempts: 0,
  renameFailures: [] as string[],
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: (async (...args: Parameters<typeof actual.rename>) => {
      state.renameAttempts += 1
      const code = state.renameFailures.shift()
      if (code !== undefined) {
        if (code === 'NO_CODE') throw new Error('injected rename failure without a code')
        throw Object.assign(new Error(`${code}: injected rename failure`), { code })
      }
      return actual.rename(...args)
    }),
  }
})

const scratchDirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  state.renameAttempts = 0
  state.renameFailures.length = 0
  await Promise.all(scratchDirs.splice(0).map(dir => rm(dir, {
    force: true,
    maxRetries: 10,
    recursive: true,
    retryDelay: 20,
  })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-storage-json-atomic-'))
  scratchDirs.push(dir)
  return dir
}

describe('writeAtomic Windows rename retries', () => {
  it('retries transient interference and commits the replacement', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const dir = await scratch()
    const target = join(dir, 'workspace.json')
    await writeFile(target, 'old', 'utf8')
    state.renameFailures.push('EPERM', 'EPERM')
    await writeAtomic(target, 'new')
    expect(await readFile(target, 'utf8')).toBe('new')
    expect(state.renameAttempts).toBe(3)
  })

  it('does not retry a failure without a transient code', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const target = join(await scratch(), 'workspace.json')
    state.renameFailures.push('ENOENT')
    await expect(writeAtomic(target, 'new')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(state.renameAttempts).toBe(1)
  })

  it('does not retry a failure without a code', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const target = join(await scratch(), 'workspace.json')
    state.renameFailures.push('NO_CODE')
    await expect(writeAtomic(target, 'new')).rejects.toThrow('injected rename failure without a code')
    expect(state.renameAttempts).toBe(1)
  })

  it('throws after bounded retries expire and leaves no temp sibling', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const dir = await scratch()
    const target = join(dir, 'workspace.json')
    state.renameFailures.push(...Array.from({ length: 9 }, () => 'EPERM'))
    await expect(writeAtomic(target, 'new')).rejects.toMatchObject({ code: 'EPERM' })
    expect(state.renameAttempts).toBe(9)
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('does not retry rename failures outside Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const target = join(await scratch(), 'workspace.json')
    state.renameFailures.push('EPERM')
    await expect(writeAtomic(target, 'new')).rejects.toMatchObject({ code: 'EPERM' })
    expect(state.renameAttempts).toBe(1)
  })
})
