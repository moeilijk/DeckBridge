import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:net'
import { WebSocket } from 'ws'

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

function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (cond()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout'))
      setTimeout(tick, 10)
    }
    tick()
  })
}

// Issue #1: re-registering a Property Inspector on the SAME socket must re-fire
// pluginRegistered (so the host re-emits propertyInspectorDidAppear). Before the
// fix only the first message of a socket registered, so the second register went
// to handleMessage and nothing re-fired.
test('re-registering a PI on the same socket re-fires pluginRegistered', async () => {
  process.env.DECKBRIDGE_WS_PORT = String(await freePort())
  const { PluginServer } = await import('../src/core/websocket/PluginServer.js')
  const server = new PluginServer()
  await server.start()

  const events: Array<[string, string]> = []
  server.on('pluginRegistered', (uuid: string, type: string) => events.push([uuid, type]))

  const ctx = 'ctx-reregister-1'
  const ws = new WebSocket(`ws://127.0.0.1:${server.getPort()}`)
  try {
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })

    ws.send(JSON.stringify({ event: 'registerPropertyInspector', uuid: ctx }))
    await waitUntil(() => events.length >= 1)

    // Second registration on the same socket — the SDK fires the appear event again.
    ws.send(JSON.stringify({ event: 'registerPropertyInspector', uuid: ctx }))
    await waitUntil(() => events.length >= 2)

    assert.deepEqual(events, [
      [ctx, 'propertyInspector'],
      [ctx, 'propertyInspector'],
    ])
  } finally {
    ws.close()
    await server.stop()
  }
})
