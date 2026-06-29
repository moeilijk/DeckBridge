import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'

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

// End-to-end guard: boot the real PI server, fetch the actual /dashboard HTML and
// verify its inline client script PARSES. A correct /api/state is not enough — a
// single broken string literal (e.g. a stray newline from template-literal escaping)
// crashes the whole dashboard script and leaves the UI stuck on "Loading" with empty
// profile/device selectors. This test catches that entire class.

test('the served dashboard inline script is valid JavaScript', async () => {
  process.env.DECKBRIDGE_PI_PORT = String(await freePort())
  const { PropertyInspectorServer } = await import('../src/core/pi/PropertyInspectorServer.js')
  const server = new PropertyInspectorServer()
  const dir = await mkdtemp(join(tmpdir(), 'deckbridge-pi-'))
  try {
    await server.start(dir)
    const res = await fetch(`http://127.0.0.1:${server.getPort()}/dashboard`)
    const html = await res.text()
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    assert.ok(scripts.length > 0, 'dashboard should contain an inline script')
    const main = scripts.reduce((a, b) => (b.length > a.length ? b : a))
    // new Function only parses; it never runs the body, so undefined browser globals
    // (document, fetch, WebSocket) are fine. A SyntaxError means the script is broken.
    assert.doesNotThrow(() => new Function(main), 'dashboard client script must parse')
  } finally {
    await server.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
