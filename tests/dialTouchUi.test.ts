import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('dashboard exposes current relurl build marker', async () => {
  const source = await readFile('src/core/pi/PropertyInspectorServer.ts', 'utf8')
  assert.match(source, /BUILD relurl-1774/)
})

test('dial display click only selects configured dials', async () => {
  const source = await readFile('src/core/pi/PropertyInspectorServer.ts', 'utf8')
  const displayClickIndex = source.indexOf('display.addEventListener("click", function(keyIdx, event)')
  assert.notEqual(displayClickIndex, -1, 'dial display click handler should be explicit')

  const handler = source.slice(displayClickIndex, source.indexOf('display.addEventListener("contextmenu"', displayClickIndex))
  assert.match(handler, /activateKey\(keyIdx\)/)
  assert.doesNotMatch(handler, /sendDialTouch/)
})

test('dial touch control still sends touch event', async () => {
  const source = await readFile('src/core/pi/PropertyInspectorServer.ts', 'utf8')
  const touchIndex = source.indexOf('touch.addEventListener("click", function(idx, event)')
  assert.notEqual(touchIndex, -1, 'dial touch button handler should be explicit')

  const handler = source.slice(touchIndex, source.indexOf('var inc = document.createElement("button")', touchIndex))
  assert.match(handler, /sendDialTouch\(idx\)/)
})

test('selecting a tile does not rebuild the deck', async () => {
  const source = await readFile('src/core/pi/PropertyInspectorServer.ts', 'utf8')
  const activateIndex = source.indexOf('function activateKey(keyIndex)')
  assert.notEqual(activateIndex, -1, 'activateKey should exist')

  const handler = source.slice(activateIndex, source.indexOf('async function createFolderAt', activateIndex))
  assert.match(handler, /renderSelectionState\(\)/)
  assert.match(handler, /renderInspector\(\)/)
  assert.doesNotMatch(handler, /render\(\)/)
})

test('patchDeckImages skips the dial-rotary controls element', async () => {
  // The rotary carries data-key-index for selection highlighting but is not a
  // feedback target. Without skipping it, the dial branch hits the has-feedback
  // mismatch and calls renderDeck() every poll, freezing all tiles/dials with a
  // stale state while the Property Inspector is open.
  const source = await readFile('src/core/pi/PropertyInspectorServer.ts', 'utf8')
  const idx = source.indexOf('function patchDeckImages(images)')
  assert.notEqual(idx, -1, 'patchDeckImages should exist')
  const body = source.slice(idx, source.indexOf('\n    function ', idx + 10))
  assert.match(body, /classList\.contains\("dial-rotary"\)\)\s*continue/)
})
