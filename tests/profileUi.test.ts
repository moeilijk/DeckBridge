import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'

// Render-level test for the dashboard profile selector. Per the dial-development
// rules (lhm-streamdeck/AGENTS.md): assert the rendered, user-visible DOM result,
// not just that /api/profiles returns the right data. Runs the actual client
// renderProfileSelect against a real DOM (jsdom).

const SOURCE = 'src/core/pi/PropertyInspectorServer.ts'

async function extractClientFn(signature: string): Promise<string> {
  const source = await readFile(SOURCE, 'utf8')
  const start = source.indexOf(signature)
  assert.notEqual(start, -1, `client function not found: ${signature}`)
  const end = source.indexOf('\n    function ', start + 10)
  return source.slice(start, end < 0 ? undefined : end)
}

test('renderProfileSelect lists profiles, marks the active one, and gates the delete button', async () => {
  const src = await extractClientFn('function renderProfileSelect()')
  const dom = new JSDOM('<select id="profileSelect"></select><button id="profileDeleteBtn"></button>')
  const d = dom.window.document
  const byId = (id: string) => d.getElementById(id)
  const factory = new Function('document', 'byId', 'state', `${src}\n; return renderProfileSelect;`)

  // Two profiles, 'work' active: both options render, active is selected, delete enabled.
  const multi = { profiles: [{ name: 'default', active: false }, { name: 'work', active: true }], activeProfile: 'work' }
  factory(d, byId, multi)()

  const select = d.getElementById('profileSelect') as unknown as HTMLSelectElement
  assert.deepEqual(Array.from(select.options).map((o) => o.value), ['default', 'work'])
  assert.equal(select.value, 'work', 'the active profile is selected in the dropdown')
  assert.equal((d.getElementById('profileDeleteBtn') as unknown as HTMLButtonElement).disabled, false)

  // A single profile: the delete button must be disabled (cannot delete the last one).
  const single = { profiles: [{ name: 'default', active: true }], activeProfile: 'default' }
  factory(d, byId, single)()

  assert.deepEqual(Array.from(select.options).map((o) => o.value), ['default'])
  assert.equal((d.getElementById('profileDeleteBtn') as unknown as HTMLButtonElement).disabled, true)
})

test('renderProfileSelect shows the app binding in the option label and highlights the app button', async () => {
  const src = await extractClientFn('function renderProfileSelect()')
  const dom = new JSDOM('<select id="profileSelect"></select><button id="profileDeleteBtn"></button><button id="profileAppBtn"></button>')
  const d = dom.window.document
  const byId = (id: string) => d.getElementById(id)
  const factory = new Function('document', 'byId', 'state', `${src}\n; return renderProfileSelect;`)

  // 'streaming' is active and bound to the 'obs' application.
  const state = {
    profiles: [{ name: 'default', active: false }, { name: 'streaming', active: true, app: 'obs' }],
    activeProfile: 'streaming',
  }
  factory(d, byId, state)()

  const select = d.getElementById('profileSelect') as unknown as HTMLSelectElement
  const streamingOption = Array.from(select.options).find((o) => o.value === 'streaming')
  assert.ok(streamingOption && streamingOption.textContent.includes('obs'), 'bound app shows in the option label')

  const appBtn = d.getElementById('profileAppBtn') as unknown as HTMLButtonElement
  assert.match(appBtn.title, /obs/, 'app button tooltip names the bound application')
  assert.equal(appBtn.style.color, 'rgb(0, 230, 118)', 'app button is highlighted when the active profile is bound')
})
