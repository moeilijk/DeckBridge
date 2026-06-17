import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'

// Render-level tests for the dashboard's dial touch-strip segments. These run the
// actual client function against a real DOM (jsdom) instead of matching source
// text, so they catch "the plugin keeps producing images but the screen freezes"
// bugs. (Local browser/DOM testing IS available — jsdom is a devDependency.)

const SOURCE = 'src/core/pi/PropertyInspectorServer.ts'

async function extractClientFn(signature: string): Promise<string> {
  const source = await readFile(SOURCE, 'utf8')
  const start = source.indexOf(signature)
  assert.notEqual(start, -1, `client function not found: ${signature}`)
  const end = source.indexOf('\n    function ', start + 10)
  return source.slice(start, end < 0 ? undefined : end)
}

function makeDeck() {
  const dom = new JSDOM('<div id="deck"></div>')
  const d = dom.window.document
  const deck = d.getElementById('deck') as HTMLElement
  // One dial touch-strip segment (the .dial-display) showing a feedback image,
  const display = d.createElement('div')
  display.className = 'key dial-display configured has-feedback'
  display.dataset.keyIndex = '1000'
  const img = d.createElement('img')
  img.className = 'dial-feedback-image'
  img.setAttribute('src', 'data:OLD')
  display.appendChild(img)
  // and the dial-rotary controls element, which also carries data-key-index.
  const rotary = d.createElement('div')
  rotary.className = 'dial-rotary configured'
  rotary.dataset.keyIndex = '1000'
  deck.appendChild(display)
  deck.appendChild(rotary)
  return { d, img }
}

test('patchDeckImages updates dial segment image in place and never rebuilds via the rotary', async () => {
  const src = await extractClientFn('function patchDeckImages(images)')
  const { d, img } = makeDeck()

  let renderDeckCalls = 0
  const byId = (id: string) => d.getElementById(id)
  const isDialIndex = (i: number) => i >= 1000
  const renderDeck = () => { renderDeckCalls += 1 }
  const state = { primaryDeviceId: 'dev' }

  const factory = new Function('byId', 'isDialIndex', 'renderDeck', 'state', `${src}\n; return patchDeckImages;`)
  const patchDeckImages = factory(byId, isDialIndex, renderDeck, state)

  patchDeckImages([{ deviceId: 'dev', keyIndex: 1000, feedbackImageDataUrl: 'data:NEW' }])

  // The rotary (data-key-index, no has-feedback) must be skipped: otherwise the
  // dial branch hits the has-feedback mismatch and calls renderDeck() every poll,
  // which with a stale state (Property Inspector open) freezes all tiles/dials.
  assert.equal(renderDeckCalls, 0, 'must not rebuild the deck for the rotary controls element')
  assert.equal(img.getAttribute('src'), 'data:NEW', 'dial segment image patched in place (stays live)')
})
