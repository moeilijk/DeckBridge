import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('dashboard exposes current relurl build marker', async () => {
  const source = await readFile('src/core/pi/PropertyInspectorServer.ts', 'utf8')
  assert.match(source, /BUILD relurl-1776/)
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
