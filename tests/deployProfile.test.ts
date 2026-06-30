import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { deployStreamDeckProfileArchive } from '../src/core/profiles/streamDeckProfile.js'

const execFileAsync = promisify(execFile)

// Build a real .streamDeckProfile zip (same shape as Elgato's lights-out sample)
// so the deploy path is exercised end to end: unzip -> parse -> convert -> write.
async function buildArchive(dir: string): Promise<string> {
  const sdProfile = join(dir, 'ABC123.sdProfile')
  const pageDir = join(sdProfile, 'Profiles', 'page-1')
  await mkdir(pageDir, { recursive: true })
  await writeFile(join(sdProfile, 'manifest.json'), JSON.stringify({
    Device: { Model: '20GBD9901', UUID: '' },
    Name: 'Lights Out',
    Pages: { Current: 'page-1', Default: 'page-1', Pages: ['page-1'] },
    Version: '2.0',
  }))
  await writeFile(join(pageDir, 'manifest.json'), JSON.stringify({
    Controllers: [
      {
        Type: 'Keypad',
        Actions: {
          '0,0': { UUID: 'com.elgato.lightsout.reset', Settings: {}, State: 0 },
          '3,1': { UUID: 'com.elgato.lightsout.gamepiece', Settings: { piece: 7 }, State: 1 },
        },
      },
      { Type: 'Encoder', Actions: { '0': { UUID: 'com.elgato.lightsout.dial', Settings: {}, State: 0 } } },
    ],
    Type: 'Keypad',
  }))
  const archive = join(dir, 'sdp.streamDeckProfile')
  // zip the .sdProfile directory at the archive root.
  await execFileAsync('zip', ['-q', '-r', archive, 'ABC123.sdProfile'], { cwd: dir })
  return archive
}

test('deployStreamDeckProfileArchive unzips, converts and writes a DeckBridge profile', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deckbridge-deploy-'))
  try {
    const archive = await buildArchive(dir)
    const destPath = join(dir, 'out', 'lightsout.json')

    let n = 0
    const ok = await deployStreamDeckProfileArchive({
      archivePath: archive,
      pluginId: 'com.elgato.lightsout',
      deviceId: 'deckbridge-plus-0',
      columns: 4,
      destPath,
      newContext: () => `ctx-${n++}`,
    })
    assert.equal(ok, true)

    const profile = JSON.parse(await readFile(destPath, 'utf8'))
    const slots = profile.pages[0].slots as Array<{ keyIndex: number; actionId: string; pluginId: string; deviceId: string; settings: unknown; state: number }>
    const byKey = new Map(slots.map((s) => [s.keyIndex, s]))

    assert.equal(byKey.get(0)?.actionId, 'com.elgato.lightsout.reset')   // 0,0 -> 0
    assert.equal(byKey.get(7)?.actionId, 'com.elgato.lightsout.gamepiece') // 3,1 -> 7
    assert.deepEqual(byKey.get(7)?.settings, { piece: 7 })
    assert.equal(byKey.get(7)?.state, 1)
    assert.equal(byKey.get(1000)?.actionId, 'com.elgato.lightsout.dial')   // encoder 0 -> 1000
    assert.equal(byKey.get(0)?.pluginId, 'com.elgato.lightsout')
    assert.equal(byKey.get(0)?.deviceId, 'deckbridge-plus-0')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('deployStreamDeckProfileArchive returns false for a missing archive', async () => {
  const ok = await deployStreamDeckProfileArchive({
    archivePath: '/nonexistent/none.streamDeckProfile',
    pluginId: 'x', deviceId: 'd', columns: 4, destPath: join(tmpdir(), 'x.json'),
  })
  assert.equal(ok, false)
})
