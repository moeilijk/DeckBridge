import assert from 'node:assert/strict'
import { test } from 'node:test'
import { convertStreamDeckProfile, type ElgatoPage } from '../src/core/profiles/streamDeckProfile.js'

// Fixture mirrors a real Elgato .streamDeckProfile page (lights-out sdp.streamDeckProfile):
// a Keypad controller keyed by "column,row" plus an Encoder controller for dials.
const page: ElgatoPage = {
  Controllers: [
    {
      Type: 'Keypad',
      Actions: {
        '0,0': { UUID: 'com.elgato.lightsout.reset', Settings: {}, State: 0 },
        '3,1': { UUID: 'com.elgato.lightsout.gamepiece', Settings: { piece: 7 }, State: 1 },
        '2,0': { UUID: 'com.elgato.lightsout.gamepiece', Settings: {}, State: 0 },
      },
    },
    {
      Type: 'Encoder',
      Actions: {
        '0': { UUID: 'com.elgato.lightsout.dial', Settings: { v: 1 }, State: 0 },
      },
    },
  ],
}

let counter = 0
const newContext = () => `ctx-${counter++}`

test('convertStreamDeckProfile maps keypad coordinates, encoder dials, settings and state', () => {
  counter = 0
  const result = convertStreamDeckProfile({
    pluginId: 'com.elgato.lightsout',
    deviceId: 'deckbridge-plus-0',
    columns: 4,
    top: { Name: 'Lights Out', Pages: { Pages: ['p1'] } },
    pages: { p1: page },
    newContext,
  })

  assert.equal(result.pages.length, 1)
  const slots = result.pages[0].slots
  const byKey = new Map(slots.map((s) => [s.keyIndex, s]))

  // "column,row" → row * columns + column
  assert.equal(byKey.get(0)?.actionId, 'com.elgato.lightsout.reset') // 0,0 -> 0
  assert.equal(byKey.get(7)?.actionId, 'com.elgato.lightsout.gamepiece') // 3,1 -> 1*4+3
  assert.equal(byKey.get(2)?.actionId, 'com.elgato.lightsout.gamepiece') // 2,0 -> 2

  // settings and state carry across
  assert.deepEqual(byKey.get(7)?.settings, { piece: 7 })
  assert.equal(byKey.get(7)?.state, 1)

  // encoder dial 0 -> keyIndex 1000
  assert.equal(byKey.get(1000)?.actionId, 'com.elgato.lightsout.dial')
  assert.deepEqual(byKey.get(1000)?.settings, { v: 1 })

  // plugin id and device id are stamped on every slot, contexts are unique
  for (const slot of slots) {
    assert.equal(slot.pluginId, 'com.elgato.lightsout')
    assert.equal(slot.deviceId, 'deckbridge-plus-0')
  }
  assert.equal(new Set(slots.map((s) => s.context)).size, slots.length)
})

test('convertStreamDeckProfile preserves page order and tolerates empty pages', () => {
  counter = 0
  const result = convertStreamDeckProfile({
    pluginId: 'com.example',
    deviceId: 'dev',
    columns: 4,
    top: { Pages: { Pages: ['a', 'b'] } },
    pages: {
      a: { Controllers: [{ Type: 'Keypad', Actions: { '0,0': { UUID: 'com.example.one' } } }] },
      b: { Controllers: [{ Type: 'Keypad', Actions: {} }] },
    },
    newContext,
  })

  assert.equal(result.pages.length, 2)
  assert.equal(result.pages[0].slots[0].actionId, 'com.example.one')
  assert.deepEqual(result.pages[1].slots, [])
})

test('convertStreamDeckProfile skips actions without a UUID and never crashes on a missing page', () => {
  counter = 0
  const result = convertStreamDeckProfile({
    pluginId: 'com.example',
    deviceId: 'dev',
    columns: 4,
    top: { Pages: { Pages: ['a', 'missing'] } },
    pages: { a: { Controllers: [{ Type: 'Keypad', Actions: { '0,0': {}, '1,0': { UUID: 'keep' } } }] } },
    newContext,
  })

  assert.equal(result.pages.length, 1) // missing page id dropped
  assert.deepEqual(result.pages[0].slots.map((s) => s.actionId), ['keep'])
})
