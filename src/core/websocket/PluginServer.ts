import { WebSocketServer, WebSocket } from 'ws'
import { EventEmitter } from 'events'
import { IncomingMessage } from 'http'

interface PluginClient {
  uuid: string
  type: 'plugin' | 'propertyInspector'
  socket: WebSocket
}

export class PluginServer extends EventEmitter {
  private wss: WebSocketServer | null = null
  private clients = new Map<string, PluginClient>()
  private port: number = 0

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.wss = new WebSocketServer({ port: 0 }, () => {
        const addr = this.wss!.address() as { port: number }
        this.port = addr.port
        console.log(`PluginServer luistert op poort ${this.port}`)
        resolve()
      })

      this.wss.on('connection', (socket: WebSocket, _req: IncomingMessage) => {
        socket.once('message', (data) => this.handleRegistration(socket, data.toString()))
        socket.on('error', (err) => console.error('WebSocket fout:', err))
      })
    })
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.wss?.close(() => resolve())
    })
  }

  getPort(): number {
    return this.port
  }

  private handleRegistration(socket: WebSocket, raw: string): void {
    let msg: { event: string; uuid: string }
    try {
      msg = JSON.parse(raw)
    } catch {
      socket.close()
      return
    }

    if (msg.event !== 'registerPlugin' && msg.event !== 'registerPropertyInspector') {
      socket.close()
      return
    }

    const client: PluginClient = {
      uuid: msg.uuid,
      type: msg.event === 'registerPlugin' ? 'plugin' : 'propertyInspector',
      socket,
    }

    this.clients.set(msg.uuid, client)
    console.log(`Plugin geregistreerd: ${msg.uuid} (${client.type})`)
    this.emit('pluginRegistered', msg.uuid, client.type)

    socket.on('message', (data) => this.handleMessage(client, data.toString()))
    socket.on('close', () => {
      this.clients.delete(msg.uuid)
      console.log(`Plugin verbroken: ${msg.uuid}`)
    })
  }

  private handleMessage(client: PluginClient, raw: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    this.emit('pluginMessage', client.uuid, msg)
  }

  sendToPlugin(uuid: string, payload: Record<string, unknown>): void {
    const client = this.clients.get(uuid)
    if (client?.socket.readyState === WebSocket.OPEN) {
      client.socket.send(JSON.stringify(payload))
    }
  }
}
