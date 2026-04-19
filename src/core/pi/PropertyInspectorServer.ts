import { createServer, IncomingMessage, ServerResponse, Server } from 'http'
import { createReadStream } from 'fs'
import { join, extname } from 'path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
}

export class PropertyInspectorServer {
  private server: Server | null = null
  private port: number = 0
  private pluginBaseDir: string = ''

  async start(pluginBaseDir: string): Promise<void> {
    this.pluginBaseDir = pluginBaseDir

    this.server = createServer((req, res) => this.handleRequest(req, res))

    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => {
        this.port = (this.server!.address() as { port: number }).port
        console.log(`PI server op poort ${this.port}`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }

  getPort(): number {
    return this.port
  }

  // Geeft de URL terug waarmee een browser de PI voor een specifieke plugin/actie opent.
  // context = context UUID van de knop (wordt als query param meegestuurd zodat de PI
  // weet voor welke knop hij opent).
  getUrl(pluginId: string, piFile: string, context: string, wsPort: number): string {
    const params = new URLSearchParams({ context, wsPort: String(wsPort) })
    return `http://127.0.0.1:${this.port}/${pluginId}/${piFile}?${params}`
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`)
    // Pathname: /<pluginId>/<...filePath>
    // bijv: /com.moeilijk.lhm/index_pi.html
    const parts = url.pathname.slice(1).split('/')
    if (parts.length < 2) {
      res.writeHead(400)
      res.end('Bad Request')
      return
    }

    const pluginId = parts[0]
    const filePath = parts.slice(1).join('/')
    const fullPath = join(this.pluginBaseDir, `${pluginId}.sdPlugin`, filePath)
    const mime = MIME[extname(fullPath).toLowerCase()] ?? 'application/octet-stream'

    res.setHeader('Content-Type', mime)
    res.setHeader('Access-Control-Allow-Origin', '*')

    const stream = createReadStream(fullPath)
    stream.on('error', () => {
      res.writeHead(404)
      res.end('Not Found')
    })
    stream.pipe(res)
  }
}
