import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('dial display click sends a touch event for configured dials', async () => {
  const source = await readFile('src/core/pi/PropertyInspectorServer.ts', 'utf8')
  const displayClickIndex = source.indexOf('display.addEventListener("click", function(idx, keyIdx, event)')
  assert.notEqual(displayClickIndex, -1, 'dial display click handler should be explicit')

  const handler = source.slice(displayClickIndex, source.indexOf('display.addEventListener("contextmenu"', displayClickIndex))
  assert.match(handler, /activateKey\(keyIdx\)/)
  assert.match(handler, /slotForKey\(keyIdx\)/)
  assert.match(handler, /sendDialTouch\(idx\)/)
})
