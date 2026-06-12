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
  private clients = new Map<string, PluginClient>()      // pluginUUID → plugin
  private piByContext = new Map<string, PluginClient>()  // context UUID → PI
  private port: number = 0
  private readonly debugPI: boolean = process.env.DECKBRIDGE_DEBUG_PI === '1'
  private readonly preferredPort: number = Number(process.env.DECKBRIDGE_WS_PORT ?? 37685)

  private logPIDebug(source: string, payload: unknown): void {
    if (!this.debugPI) return
    const ts = new Date().toISOString()
    console.log(`[PI-WS ${ts}] ${source}: ${JSON.stringify(payload)}`)
  }

  async start(): Promise<void> {
    const requestedPort = Number.isInteger(this.preferredPort) && this.preferredPort > 0 ? this.preferredPort : 37685
    await this.listenOnPort(requestedPort)
  }

  private async listenOnPort(port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.wss = new WebSocketServer({ port, host: '127.0.0.1' }, () => {
        const addr = this.wss!.address() as { port: number }
        this.port = addr.port
        console.log(`PluginServer luistert op poort ${this.port}`)
        resolve()
      })
      this.wss.once('error', reject)

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

    const isPI = msg.event === 'registerPropertyInspector'
    const client: PluginClient = {
      uuid: msg.uuid,
      type: isPI ? 'propertyInspector' : 'plugin',
      socket,
    }

    if (isPI) {
      // uuid = context UUID van de knop waarvoor de PI opent
      this.piByContext.set(msg.uuid, client)
      console.log(`PI geregistreerd voor context: ${msg.uuid}`)
      this.logPIDebug('register', { context: msg.uuid, activePIs: this.piByContext.size })
      socket.on('close', () => {
        this.piByContext.delete(msg.uuid)
        this.logPIDebug('close', { context: msg.uuid, activePIs: this.piByContext.size })
        this.emit('piClosed', msg.uuid)
      })
    } else {
      this.clients.set(msg.uuid, client)
      console.log(`Plugin geregistreerd: ${msg.uuid}`)
      socket.on('close', () => {
        this.clients.delete(msg.uuid)
        console.log(`Plugin verbroken: ${msg.uuid}`)
      })
    }

    this.emit('pluginRegistered', msg.uuid, client.type)
    socket.on('message', (data) => this.handleMessage(client, data.toString()))
    socket.on('error', (err) => console.error(`[${msg.uuid}] WS fout:`, err))
  }

  private handleMessage(client: PluginClient, raw: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (client.type === 'propertyInspector') {
      this.logPIDebug('message-from-pi', {
        context: client.uuid,
        event: typeof msg.event === 'string' ? msg.event : undefined,
        action: typeof msg.action === 'string' ? msg.action : undefined,
        messageContext: typeof msg.context === 'string' ? msg.context : undefined,
      })
    }
    this.emit('pluginMessage', client.uuid, client.type, msg)
  }

  sendToPlugin(uuid: string, payload: Record<string, unknown>): void {
    const client = this.clients.get(uuid)
    if (client?.socket.readyState === WebSocket.OPEN) {
      client.socket.send(JSON.stringify(payload))
    }
  }

  sendToPropertyInspector(context: string, payload: Record<string, unknown>): void {
    const pi = this.piByContext.get(context)
    this.logPIDebug('send-to-pi', {
      context,
      hasTarget: Boolean(pi),
      event: typeof payload.event === 'string' ? payload.event : undefined,
    })
    if (pi?.socket.readyState === WebSocket.OPEN) {
      pi.socket.send(JSON.stringify(payload))
    }
  }

  hasPropertyInspector(context: string): boolean {
    return this.piByContext.has(context)
  }
}
