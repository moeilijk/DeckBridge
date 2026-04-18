const { WebSocket } = require('ws')

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, val, i, arr) => {
    if (val.startsWith('-')) acc.push([val.slice(1), arr[i + 1]])
    return acc
  }, [])
)

const counts = {}
const ws = new WebSocket(`ws://127.0.0.1:${args.port}`)

ws.addEventListener('open', () => {
  console.log('[testplugin] verbonden')
  ws.send(JSON.stringify({ event: args.registerEvent, uuid: args.pluginUUID }))
})

ws.addEventListener('message', ({ data }) => {
  const msg = JSON.parse(data)

  if (msg.event === 'willAppear') {
    counts[msg.context] = msg.payload?.settings?.count ?? 0
    send('setTitle', msg.context, { title: String(counts[msg.context]), target: 0 })
  }

  if (msg.event === 'keyDown') {
    counts[msg.context] = (counts[msg.context] ?? 0) + 1
    send('setTitle', msg.context, { title: String(counts[msg.context]), target: 0 })
    send('setSettings', msg.context, { count: counts[msg.context] })
  }
})

function send(event, context, payload) {
  ws.send(JSON.stringify({ event, context, payload }))
}

ws.addEventListener('error', (err) => console.error('[testplugin] fout:', err.message))
ws.addEventListener('close', () => console.log('[testplugin] verbinding gesloten'))
