import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ProfileManager, type ButtonSlot } from '../src/core/profiles/ProfileManager.js'

const deviceId = '/dev/test-deck'

async function withProfileDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'deckbridge-profile-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function slot(context: string, settings: Record<string, unknown> = {}): ButtonSlot {
  return {
    pluginId: 'com.example.plugin',
    actionId: 'com.example.plugin.action',
    context,
    settings,
  }
}

test('missing default profile loads as an empty profile and saves no slots', async () => {
  await withProfileDir(async (dir) => {
    const manager = new ProfileManager(dir)

    await manager.load()
    assert.deepEqual(manager.getAllSlots(), [])

    await manager.save()
    const saved = JSON.parse(await readFile(join(dir, 'default.json'), 'utf8'))
    assert.deepEqual(saved, { slots: [] })
  })
})

test('named profiles are stored separately from default', async () => {
  await withProfileDir(async (dir) => {
    const demo = new ProfileManager({ profileDir: dir, profileName: 'demo-xl' })
    demo.setSlot(deviceId, 0, slot('demo-context'))
    await demo.save()

    const freshDefault = new ProfileManager({ profileDir: dir })
    await freshDefault.load()
    assert.equal(freshDefault.getAllSlots().length, 0)

    const freshDemo = new ProfileManager({ profileDir: dir, profileName: 'demo-xl' })
    await freshDemo.load()
    assert.equal(freshDemo.getSlot(deviceId, 0)?.context, 'demo-context')
  })
})

test('replacing a slot removes the old context index', async () => {
  await withProfileDir(async (dir) => {
    const manager = new ProfileManager(dir)
    manager.setSlot(deviceId, 0, slot('first'))
    manager.setSlot(deviceId, 0, slot('second'))

    assert.equal(manager.getSlotByContext('first'), undefined)
    assert.equal(manager.getSlotByContext('second')?.keyIndex, 0)
  })
})

test('removing a slot removes its context index', async () => {
  await withProfileDir(async (dir) => {
    const manager = new ProfileManager(dir)
    manager.setSlot(deviceId, 0, slot('removed'))

    manager.removeSlot(deviceId, 0)

    assert.equal(manager.getSlot(deviceId, 0), undefined)
    assert.equal(manager.getSlotByContext('removed'), undefined)
  })
})

test('moving a slot to an empty key preserves context and settings', async () => {
  await withProfileDir(async (dir) => {
    const manager = new ProfileManager(dir)
    manager.setSlot(deviceId, 0, slot('source', { value: 42 }))

    const result = manager.moveSlot(deviceId, 0, deviceId, 4)

    assert.deepEqual({ moved: result.moved, swapped: result.swapped }, { moved: true, swapped: false })
    assert.equal(manager.getSlot(deviceId, 0), undefined)
    assert.equal(manager.getSlot(deviceId, 4)?.context, 'source')
    assert.deepEqual(manager.getSlot(deviceId, 4)?.settings, { value: 42 })
    assert.equal(manager.getSlotByContext('source')?.keyIndex, 4)
  })
})

test('moving a slot onto another slot swaps both contexts', async () => {
  await withProfileDir(async (dir) => {
    const manager = new ProfileManager(dir)
    manager.setSlot(deviceId, 0, slot('left', { label: 'left' }))
    manager.setSlot(deviceId, 1, slot('right', { label: 'right' }))

    const result = manager.moveSlot(deviceId, 0, deviceId, 1)

    assert.deepEqual({ moved: result.moved, swapped: result.swapped }, { moved: true, swapped: true })
    assert.equal(manager.getSlot(deviceId, 0)?.context, 'right')
    assert.equal(manager.getSlot(deviceId, 1)?.context, 'left')
    assert.deepEqual(manager.getSlot(deviceId, 0)?.settings, { label: 'right' })
    assert.deepEqual(manager.getSlot(deviceId, 1)?.settings, { label: 'left' })
    assert.equal(manager.getSlotByContext('right')?.keyIndex, 0)
    assert.equal(manager.getSlotByContext('left')?.keyIndex, 1)
  })
})

test('saved slots are deterministic and load back with context indexes', async () => {
  await withProfileDir(async (dir) => {
    const manager = new ProfileManager(dir)
    manager.setSlot(deviceId, 2, slot('two'))
    manager.setSlot(deviceId, 0, slot('zero'))
    await manager.save()

    const saved = JSON.parse(await readFile(join(dir, 'default.json'), 'utf8'))
    assert.deepEqual(saved.slots.map((entry: { keyIndex: number }) => entry.keyIndex), [0, 2])

    const reloaded = new ProfileManager(dir)
    await reloaded.load()
    assert.equal(reloaded.getSlotByContext('zero')?.keyIndex, 0)
    assert.equal(reloaded.getSlotByContext('two')?.keyIndex, 2)
  })
})
