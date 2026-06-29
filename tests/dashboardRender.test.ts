import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { JSDOM } from 'jsdom'

// E2E-at-the-DOM test (per lhm-streamdeck/AGENTS.md: "End-to-end means reaching the
// rendered UI (DOM), not the API boundary"). It boots the real PI server, loads the
// actual /dashboard into jsdom, RUNS the real client script with fetch wired to the
// server, and asserts the Profile and Device selectors actually populate. A broken
// inline script (e.g. a stray newline in a string) leaves the selectors empty and
// the header on "Loading" — exactly the failure a protocol/API test cannot see.

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port
      probe.close(() => resolve(port))
    })
  })
}

test('the live dashboard renders the profile and device selectors', async () => {
  process.env.DECKBRIDGE_PI_PORT = String(await freePort())
  const { PropertyInspectorServer } = await import('../src/core/pi/PropertyInspectorServer.js')
  const server = new PropertyInspectorServer()
  server.setLayoutProvider(() => ({ columns: 4, rows: 2, totalKeys: 8 }))
  server.setPrimaryDeviceProvider(() => 'dev1')
  server.setDevicesProvider(() => [
    { id: 'dev1', name: 'Stream Deck +', model: 'streamdeck-plus', type: 7, columns: 4, rows: 2, totalKeys: 8, dials: 4 },
  ])
  server.setProfileProvider(() => ({
    profiles: [{ name: 'default', active: true }, { name: 'streaming', active: false, app: 'obs' }],
    active: 'default',
  }))

  const dir = await mkdtemp(join(tmpdir(), 'deckbridge-pi-'))
  let dom: JSDOM | undefined
  try {
    await server.start(dir)
    const origin = `http://127.0.0.1:${server.getPort()}`
    const html = await (await fetch(origin + '/dashboard')).text()

    dom = new JSDOM(html, {
      runScripts: 'dangerously',
      url: origin + '/',
      beforeParse(window) {
        // jsdom has no fetch/WebSocket — route the dashboard's fetch to the real server.
        ;(window as unknown as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
          fetch(typeof input === 'string' ? input : input.toString(), init)) as typeof fetch
        ;(window as unknown as { WebSocket: unknown }).WebSocket = class {
          close() {}
          send() {}
          addEventListener() {}
        }
        ;(window as unknown as { alert: () => void }).alert = () => {}
      },
    })
    const doc = dom.window.document

    // Wait for loadState() + render() to populate the device selector.
    const deviceSelect = () => doc.getElementById('deviceSelect') as HTMLSelectElement | null
    const deadline = Date.now() + 4000
    while ((deviceSelect()?.options.length ?? 0) === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
    }

    const devOptions = Array.from(deviceSelect()?.options ?? []).map((o) => o.textContent)
    const profOptions = Array.from((doc.getElementById('profileSelect') as HTMLSelectElement).options).map((o) => o.textContent)
    dom.window.close()

    assert.ok(devOptions.length > 0, 'device selector should populate (UI not stuck on "Loading")')
    assert.match(devOptions.join('|'), /Stream Deck/, 'device option shows the device name')
    assert.ok(profOptions.length >= 2, 'profile selector should list the profiles')
    assert.ok(profOptions.some((t) => (t ?? '').includes('obs')), 'a bound profile shows its app in the option label')
  } finally {
    dom?.window.close()
    await server.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
