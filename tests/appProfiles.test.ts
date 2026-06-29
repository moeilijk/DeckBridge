import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveAppProfileSwitch, buildAppToProfile } from '../src/core/profiles/appProfiles.js'

const appToProfile = new Map<string, string>([
  ['obs', 'streaming'],
  ['blender', 'modeling'],
])

test('a bound app that just launched switches to its profile', () => {
  const decision = resolveAppProfileSwitch({
    current: new Set(['obs']),
    previous: new Set(),
    appToProfile,
    activeApp: null,
    manualProfile: 'default',
  })
  assert.deepEqual(decision, { switchTo: 'streaming', activeApp: 'obs' })
})

test('an unbound app launching does not switch', () => {
  const decision = resolveAppProfileSwitch({
    current: new Set(['firefox']),
    previous: new Set(),
    appToProfile,
    activeApp: null,
    manualProfile: 'default',
  })
  assert.deepEqual(decision, { switchTo: null, activeApp: null })
})

test('when the driving app exits, fall back to the manual profile', () => {
  const decision = resolveAppProfileSwitch({
    current: new Set(),
    previous: new Set(['obs']),
    appToProfile,
    activeApp: 'obs',
    manualProfile: 'default',
  })
  assert.deepEqual(decision, { switchTo: 'default', activeApp: null })
})

test('when the driving app exits but another bound app runs, hand over to it', () => {
  const decision = resolveAppProfileSwitch({
    current: new Set(['blender']),
    previous: new Set(['obs', 'blender']),
    appToProfile,
    activeApp: 'obs',
    manualProfile: 'default',
  })
  assert.deepEqual(decision, { switchTo: 'modeling', activeApp: 'blender' })
})

test('no change while the driving app keeps running', () => {
  const decision = resolveAppProfileSwitch({
    current: new Set(['obs']),
    previous: new Set(['obs']),
    appToProfile,
    activeApp: 'obs',
    manualProfile: 'default',
  })
  assert.deepEqual(decision, { switchTo: null, activeApp: 'obs' })
})

test('the most recently launched bound app wins within a tick', () => {
  const decision = resolveAppProfileSwitch({
    current: new Set(['obs', 'blender']),
    previous: new Set(),
    appToProfile,
    activeApp: null,
    manualProfile: 'default',
  })
  // Iteration order of the Set preserves insertion: obs then blender, last wins.
  assert.deepEqual(decision, { switchTo: 'modeling', activeApp: 'blender' })
})

test('buildAppToProfile inverts the profile→app map and drops empty bindings', () => {
  const map = buildAppToProfile({ streaming: 'obs', modeling: 'blender', idle: '' })
  assert.equal(map.get('obs'), 'streaming')
  assert.equal(map.get('blender'), 'modeling')
  assert.equal(map.size, 2)
})
