import { createServer, IncomingMessage, ServerResponse, Server } from 'http'
import { createReadStream, existsSync } from 'fs'
import { readFile } from 'fs/promises'
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

export interface SlotEntry {
  deviceId: string
  keyIndex: number
  pluginId: string
  actionId: string
  context: string
  settings: Record<string, unknown>
  piFile: string
  imageDataUrl?: string
}

export interface ActionEntry {
  pluginId: string
  pluginName: string
  actionId: string
  name: string
  tooltip: string
  icon?: string
  piFile: string
}

export interface DeviceLayout {
  columns: number
  rows: number
  totalKeys: number
}

export interface SlotAssignment {
  deviceId: string
  keyIndex: number
  pluginId: string
  actionId: string
}

export interface SlotMove {
  sourceDeviceId: string
  sourceKeyIndex: number
  targetDeviceId: string
  targetKeyIndex: number
}

// Injected before </body> in every PI HTML response so browsers can connect
// without the Elgato WebView host calling connectElgatoStreamDeckSocket directly.
const BOOTSTRAP = `<script>
(function() {
  var p = new URLSearchParams(location.search);
  function boot() {
    if (typeof connectElgatoStreamDeckSocket !== 'function') return;
    var colors = {
      buttonPressedBackgroundColor: '#303030',
      buttonPressedBorderColor: '#646464',
      buttonPressedTextColor: '#ffffff',
      disabledColor: '#3d3d3d',
      highlightColor: '#007aff',
      mouseDownColor: '#0057b8'
    };
    var info = JSON.stringify({ colors: colors, devicePixelRatio: 1,
      application: { language: 'en', platform: 'mac', platformVersion: '14.0', version: '7.3.0' },
      plugin: { uuid: p.get('pluginId') || '', version: '0' } });
    var actionInfo = JSON.stringify({
      action:  p.get('action')  || '',
      context: p.get('context') || '',
      device:  p.get('device')  || '',
      payload: { settings: JSON.parse(decodeURIComponent(p.get('settings') || '{}')), coordinates: { column: 0, row: 0 } }
    });
    connectElgatoStreamDeckSocket(p.get('wsPort'), p.get('context'), 'registerPropertyInspector', info, actionInfo);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
</script>`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class PropertyInspectorServer {
  private server: Server | null = null
  private port: number = 0
  private pluginBaseDir: string = ''
  private slotProvider: (() => SlotEntry[]) | null = null
  private actionProvider: (() => ActionEntry[]) | null = null
  private layoutProvider: (() => DeviceLayout) | null = null
  private primaryDeviceProvider: (() => string | null) | null = null
  private assignSlotHandler: ((assignment: SlotAssignment) => Promise<void> | void) | null = null
  private clearSlotHandler: ((deviceId: string, keyIndex: number) => Promise<void> | void) | null = null
  private moveSlotHandler: ((move: SlotMove) => Promise<void> | void) | null = null

  setSlotProvider(fn: () => SlotEntry[]): void {
    this.slotProvider = fn
  }

  setActionProvider(fn: () => ActionEntry[]): void {
    this.actionProvider = fn
  }

  setLayoutProvider(fn: () => DeviceLayout): void {
    this.layoutProvider = fn
  }

  setPrimaryDeviceProvider(fn: () => string | null): void {
    this.primaryDeviceProvider = fn
  }

  setSlotMutationHandlers(handlers: {
    assign: (assignment: SlotAssignment) => Promise<void> | void
    clear: (deviceId: string, keyIndex: number) => Promise<void> | void
    move?: (move: SlotMove) => Promise<void> | void
  }): void {
    this.assignSlotHandler = handlers.assign
    this.clearSlotHandler = handlers.clear
    this.moveSlotHandler = handlers.move ?? null
  }

  async start(pluginBaseDir: string): Promise<void> {
    this.pluginBaseDir = pluginBaseDir

    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        console.error('PI server fout:', err)
        if (!res.headersSent) res.writeHead(500)
        res.end('Internal Server Error')
      })
    })

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

  getDashboardUrl(): string {
    return `http://127.0.0.1:${this.port}/dashboard`
  }

  getUrl(slot: SlotEntry, piFile: string, wsPort: number): string {
    const params = new URLSearchParams({
      context:  slot.context,
      wsPort:   String(wsPort),
      action:   slot.actionId,
      device:   slot.deviceId,
      pluginId: slot.pluginId,
      settings: encodeURIComponent(JSON.stringify(slot.settings)),
    })
    return `http://127.0.0.1:${this.port}/${slot.pluginId}/${piFile}?${params}`
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`)
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (url.pathname === '/') {
      res.writeHead(302, { Location: `/dashboard${url.search}` })
      res.end()
      return
    }

    if ((url.pathname === '/dashboard' || url.pathname === '/dashboard/') && req.method === 'GET') {
      this.serveDashboard(res, url)
      return
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      this.serveState(res, url)
      return
    }

    if (url.pathname === '/api/slots' && req.method === 'POST') {
      await this.assignSlot(req, res, url)
      return
    }

    if (url.pathname === '/api/slots/move' && req.method === 'POST') {
      await this.moveSlot(req, res, url)
      return
    }

    if (url.pathname === '/api/slots' && req.method === 'DELETE') {
      await this.clearSlot(res, url)
      return
    }

    if (url.pathname.startsWith('/api/')) {
      res.writeHead(404)
      res.end('Not Found')
      return
    }

    this.servePluginFile(url, res)
  }

  private servePluginFile(url: URL, res: ServerResponse): void {
    const parts = url.pathname.slice(1).split('/')
    if (parts.length < 2) {
      res.writeHead(400)
      res.end('Bad Request')
      return
    }

    const pluginId = parts[0]
    const filePath = parts.slice(1).join('/')
    const fullPath = join(this.pluginBaseDir, `${pluginId}.sdPlugin`, filePath)
    const ext = extname(fullPath).toLowerCase()
    const mime = MIME[ext] ?? 'application/octet-stream'

    res.setHeader('Content-Type', mime)

    if (ext === '.html') {
      this.serveHtmlWithBootstrap(res, fullPath)
      return
    }

    const stream = createReadStream(fullPath)
    stream.on('error', () => {
      res.writeHead(404)
      res.end('Not Found')
    })
    stream.pipe(res)
  }

  private async serveHtmlWithBootstrap(res: ServerResponse, fullPath: string): Promise<void> {
    if (!existsSync(fullPath)) {
      res.writeHead(404)
      res.end('Not Found')
      return
    }
    try {
      let html = await readFile(fullPath, 'utf8')
      html = html.replace('</body>', `${BOOTSTRAP}\n</body>`)
      res.writeHead(200)
      res.end(html)
    } catch {
      res.writeHead(500)
      res.end('Internal Server Error')
    }
  }

  private serveState(res: ServerResponse, url: URL): void {
    this.sendJson(res, 200, this.getState(url))
  }

  private getState(url: URL): Record<string, unknown> {
    const wsPort = parseInt(url.searchParams.get('wsPort') ?? '0', 10)
    const slots = this.slotProvider?.() ?? []
    const actions = this.actionProvider?.() ?? []
    const layout = this.layoutProvider?.() ?? { columns: 8, rows: 4, totalKeys: 32 }
    const primaryDeviceId = this.primaryDeviceProvider?.() ?? null

    return {
      primaryDeviceId,
      layout,
      actions,
      slots: slots.map((slot) => ({
        ...slot,
        piUrl: wsPort ? this.getUrl(slot, slot.piFile, wsPort) : '',
      })),
    }
  }

  private async assignSlot(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.assignSlotHandler) {
      this.sendJson(res, 501, { error: 'Slot assignment is not configured' })
      return
    }

    let assignment: SlotAssignment
    try {
      assignment = this.parseSlotAssignment(await this.readJson(req))
    } catch (err) {
      this.sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid request' })
      return
    }

    await this.assignSlotHandler(assignment)
    this.sendJson(res, 200, this.getState(url))
  }

  private async clearSlot(res: ServerResponse, url: URL): Promise<void> {
    if (!this.clearSlotHandler) {
      this.sendJson(res, 501, { error: 'Slot clearing is not configured' })
      return
    }

    const keyIndex = Number(url.searchParams.get('keyIndex'))
    const deviceId = url.searchParams.get('deviceId') || this.primaryDeviceProvider?.()
    if (!deviceId || !Number.isInteger(keyIndex) || keyIndex < 0) {
      this.sendJson(res, 400, { error: 'Invalid deviceId or keyIndex' })
      return
    }

    await this.clearSlotHandler(deviceId, keyIndex)
    this.sendJson(res, 200, this.getState(url))
  }

  private async moveSlot(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.moveSlotHandler) {
      this.sendJson(res, 501, { error: 'Slot moving is not configured' })
      return
    }

    let move: SlotMove
    try {
      move = this.parseSlotMove(await this.readJson(req))
    } catch (err) {
      this.sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid request' })
      return
    }

    await this.moveSlotHandler(move)
    this.sendJson(res, 200, this.getState(url))
  }

  private parseSlotAssignment(body: unknown): SlotAssignment {
    if (!isRecord(body)) throw new Error('Expected a JSON object')

    const keyIndex = Number(body.keyIndex)
    const deviceId = typeof body.deviceId === 'string' && body.deviceId
      ? body.deviceId
      : this.primaryDeviceProvider?.()
    const pluginId = typeof body.pluginId === 'string' ? body.pluginId : ''
    const actionId = typeof body.actionId === 'string' ? body.actionId : ''

    if (!deviceId) throw new Error('Missing deviceId')
    if (!Number.isInteger(keyIndex) || keyIndex < 0) throw new Error('Invalid keyIndex')
    if (!pluginId) throw new Error('Missing pluginId')
    if (!actionId) throw new Error('Missing actionId')

    return { deviceId, keyIndex, pluginId, actionId }
  }

  private parseSlotMove(body: unknown): SlotMove {
    if (!isRecord(body)) throw new Error('Expected a JSON object')

    const sourceDeviceId = typeof body.sourceDeviceId === 'string' && body.sourceDeviceId
      ? body.sourceDeviceId
      : this.primaryDeviceProvider?.()
    const targetDeviceId = typeof body.targetDeviceId === 'string' && body.targetDeviceId
      ? body.targetDeviceId
      : this.primaryDeviceProvider?.()
    const sourceKeyIndex = Number(body.sourceKeyIndex)
    const targetKeyIndex = Number(body.targetKeyIndex)

    if (!sourceDeviceId) throw new Error('Missing sourceDeviceId')
    if (!targetDeviceId) throw new Error('Missing targetDeviceId')
    if (!Number.isInteger(sourceKeyIndex) || sourceKeyIndex < 0) throw new Error('Invalid sourceKeyIndex')
    if (!Number.isInteger(targetKeyIndex) || targetKeyIndex < 0) throw new Error('Invalid targetKeyIndex')

    return { sourceDeviceId, sourceKeyIndex, targetDeviceId, targetKeyIndex }
  }

  private async readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += buffer.length
      if (length > 1024 * 1024) throw new Error('Request body too large')
      chunks.push(buffer)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    return raw ? JSON.parse(raw) : {}
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
  }

  private serveDashboard(res: ServerResponse, url: URL): void {
    const wsPort = JSON.stringify(url.searchParams.get('wsPort') ?? '')
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DeckBridge</title>
  <style>
    * { box-sizing: border-box; }
    :root {
      color-scheme: dark;
      --bg: #111315;
      --panel: #181c20;
      --panel-2: #20262c;
      --line: #303841;
      --text: #eef2f5;
      --muted: #8d98a5;
      --accent: #32c47c;
      --accent-2: #3aa0ff;
      --danger: #ef5f5f;
      --warn: #d8a63f;
    }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
      overflow: hidden;
    }
    button, input {
      font: inherit;
      letter-spacing: 0;
    }
    button {
      border: 1px solid var(--line);
      color: var(--text);
      background: var(--panel-2);
      border-radius: 7px;
      min-height: 36px;
      cursor: pointer;
    }
    button:hover:not(:disabled) {
      border-color: #53616d;
      background: #28313a;
    }
    button:disabled {
      cursor: not-allowed;
      opacity: .45;
    }
    .app {
      display: grid;
      grid-template-columns: minmax(230px, 300px) minmax(440px, 1fr) minmax(260px, 340px);
      height: 100vh;
      min-height: 620px;
    }
    .sidebar, .inspector {
      background: var(--panel);
      border-color: var(--line);
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .sidebar { border-right: 1px solid var(--line); }
    .inspector { border-left: 1px solid var(--line); }
    .header {
      height: 62px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 0 18px;
      flex: 0 0 auto;
    }
    .brand {
      font-weight: 700;
      font-size: 18px;
      white-space: nowrap;
    }
    .status {
      color: var(--muted);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .search {
      margin: 14px;
      height: 38px;
      border: 1px solid var(--line);
      background: #0f1113;
      color: var(--text);
      border-radius: 7px;
      padding: 0 12px;
      outline: none;
    }
    .search:focus {
      border-color: var(--accent-2);
    }
    .action-list {
      overflow: auto;
      padding: 0 10px 14px;
    }
    .plugin-group {
      margin: 10px 0 14px;
    }
    .plugin-name {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      margin: 0 4px 7px;
      text-transform: uppercase;
    }
    .action {
      width: 100%;
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr);
      gap: 10px;
      align-items: center;
      text-align: left;
      padding: 8px;
      margin: 5px 0;
      min-height: 50px;
      border: 1px solid var(--line);
      border-radius: 7px;
      color: var(--text);
      background: var(--panel-2);
      cursor: grab;
    }
    .action:hover {
      border-color: #53616d;
      background: #28313a;
    }
    .action:active {
      cursor: grabbing;
    }
    .action.selected {
      border-color: var(--accent);
      box-shadow: inset 0 0 0 1px rgba(50, 196, 124, .45);
    }
    .action.dragging {
      opacity: .6;
    }
    .action-icon {
      width: 34px;
      height: 34px;
      border-radius: 7px;
      background: #0d0f11;
      border: 1px solid var(--line);
      display: grid;
      place-items: center;
      overflow: hidden;
      color: var(--accent-2);
      font-size: 12px;
      font-weight: 700;
    }
    .action-icon img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .action-title, .key-label, .detail-value {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .action-title {
      font-size: 13px;
      font-weight: 650;
    }
    .action-subtitle {
      margin-top: 2px;
      color: var(--muted);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .workspace {
      min-width: 0;
      display: flex;
      flex-direction: column;
      background: #101214;
    }
    .deck-wrap {
      flex: 1;
      min-height: 0;
      display: grid;
      place-items: center;
      padding: 28px;
    }
    .deck {
      width: min(100%, 900px);
      display: grid;
      gap: 10px;
      padding: 18px;
      border-radius: 8px;
      background: #070808;
      border: 1px solid #282e33;
      box-shadow: 0 24px 80px rgba(0, 0, 0, .35);
    }
    .key {
      position: relative;
      aspect-ratio: 1;
      min-width: 0;
      min-height: 0;
      padding: 8px;
      border-radius: 8px;
      border: 1px solid #323b44;
      background: #161b20;
      display: grid;
      grid-template-rows: 18px minmax(0, 1fr) 18px;
      gap: 3px;
      text-align: left;
    }
    .key.empty {
      background: #111418;
      border-style: dashed;
      color: var(--muted);
    }
    .key.configured {
      background: linear-gradient(180deg, #17231d, #12181a);
      border-color: #375c49;
    }
    .key.has-image {
      padding: 0;
      overflow: hidden;
      display: block;
      background: #000;
      border-color: #2f3941;
    }
    .key.selected {
      border-color: var(--accent-2);
      box-shadow: 0 0 0 2px rgba(58, 160, 255, .3);
    }
    .key.drag-over {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px rgba(50, 196, 124, .25);
    }
    .key.moving {
      opacity: .55;
    }
    .floating-tile {
      position: fixed;
      z-index: 80;
      pointer-events: none;
      margin: 0;
      opacity: .96;
      transform: scale(1.04);
      transform-origin: top left;
      box-shadow: 0 18px 44px rgba(0, 0, 0, .5), 0 0 0 2px rgba(58, 160, 255, .35);
    }
    .deck.dragging .key {
      border-color: #50616f;
    }
    .deck.dragging .key.empty {
      background: #132019;
      border-color: #2d8155;
      border-style: solid;
    }
    .key-num {
      color: var(--muted);
      font-size: 11px;
      line-height: 18px;
    }
    .key-label {
      align-self: center;
      color: var(--text);
      font-size: clamp(10px, 1.1vw, 14px);
      font-weight: 700;
      text-align: center;
      white-space: normal;
      overflow-wrap: anywhere;
      line-height: 1.15;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .key-plugin {
      color: var(--muted);
      font-size: 10px;
      text-align: center;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .key-image {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
      border-radius: 7px;
      pointer-events: none;
      user-select: none;
    }
    .panel-body {
      padding: 16px;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .detail {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #121619;
      padding: 12px;
      display: grid;
      gap: 10px;
    }
    .detail-row {
      display: grid;
      grid-template-columns: 74px minmax(0, 1fr);
      gap: 10px;
      align-items: center;
      min-height: 24px;
    }
    .detail-label {
      color: var(--muted);
      font-size: 12px;
    }
    .detail-value {
      font-size: 13px;
      color: var(--text);
    }
    .actions {
      display: grid;
      gap: 8px;
    }
    .primary {
      background: #163724;
      border-color: #2d8155;
    }
    .secondary {
      background: #152739;
      border-color: #2b5f90;
    }
    .danger {
      background: #351919;
      border-color: #8f3b3b;
    }
    .pi-panel {
      display: none;
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: min(380px, 100vw);
      border-left: 1px solid var(--line);
      background: var(--panel);
      z-index: 20;
      flex-direction: column;
    }
    .pi-panel.open {
      display: flex;
    }
    .pi-frame {
      border: 0;
      flex: 1;
      background: white;
    }
    .close {
      width: 36px;
      min-height: 32px;
    }
    .context-menu {
      display: none;
      position: fixed;
      z-index: 40;
      min-width: 190px;
      padding: 6px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #151a1f;
      box-shadow: 0 18px 48px rgba(0, 0, 0, .45);
    }
    .context-menu.open {
      display: grid;
      gap: 4px;
    }
    .context-menu button {
      width: 100%;
      min-height: 34px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      text-align: left;
      padding: 0 10px;
    }
    .context-menu button:hover:not(:disabled) {
      background: #25303a;
      border-color: transparent;
    }
    .context-menu .danger-command {
      color: #ffb5b5;
    }
    @media (max-width: 980px) {
      body { overflow: auto; }
      .app {
        height: auto;
        min-height: 100vh;
        grid-template-columns: 1fr;
      }
      .sidebar, .inspector {
        border: 0;
        border-bottom: 1px solid var(--line);
      }
      .workspace {
        min-height: 560px;
      }
      .deck-wrap {
        padding: 16px;
      }
    }
  </style>
</head>
<body>
  <main class="app">
    <aside class="sidebar">
      <div class="header">
        <div class="brand">Actions</div>
        <div class="status" id="actionCount"></div>
      </div>
      <input class="search" id="actionSearch" placeholder="Search actions" autocomplete="off">
      <div class="action-list" id="actionList"></div>
    </aside>

    <section class="workspace">
      <div class="header">
        <div>
          <div class="brand">DeckBridge</div>
          <div class="status" id="deckStatus">Loading</div>
        </div>
        <button id="refreshBtn">Refresh</button>
      </div>
      <div class="deck-wrap">
        <div class="deck" id="deck"></div>
      </div>
    </section>

    <aside class="inspector">
      <div class="header">
        <div class="brand">Tile</div>
        <div class="status" id="selectedKeyLabel"></div>
      </div>
      <div class="panel-body">
        <div class="detail">
          <div class="detail-row">
            <div class="detail-label">Action</div>
            <div class="detail-value" id="tileAction">Empty</div>
          </div>
          <div class="detail-row">
            <div class="detail-label">Plugin</div>
            <div class="detail-value" id="tilePlugin">-</div>
          </div>
          <div class="detail-row">
            <div class="detail-label">Context</div>
            <div class="detail-value" id="tileContext">-</div>
          </div>
        </div>
        <div class="actions">
          <button class="primary" id="assignBtn">Assign Selected Action</button>
          <button class="secondary" id="openPiBtn">Open Property Inspector</button>
          <button class="danger" id="clearBtn">Remove Tile</button>
        </div>
      </div>
    </aside>
  </main>

  <section class="pi-panel" id="piPanel">
    <div class="header">
      <div class="brand">Property Inspector</div>
      <button class="close" id="closePiBtn">x</button>
    </div>
    <iframe class="pi-frame" id="piFrame" src="about:blank"></iframe>
  </section>

  <div class="context-menu" id="tileMenu" role="menu" aria-hidden="true">
    <button id="menuOpenPiBtn" type="button">Open Property Inspector</button>
    <button class="danger-command" id="menuRemoveBtn" type="button">Remove Tile</button>
  </div>

  <script>
    window.DECKBRIDGE_WS_PORT = ${wsPort};

    var state = null;
    var selectedKeyIndex = null;
    var selectedActionKey = null;
    var contextMenuKeyIndex = null;
    var draggingActionKey = null;
    var draggingSlot = null;
    var pointerTileDrag = null;
    var suppressTileClickUntil = 0;
    var searchValue = "";
    var liveRefreshInFlight = false;

    function byId(id) {
      return document.getElementById(id);
    }

    function actionKey(action) {
      return action.pluginId + "|" + action.actionId;
    }

    function findAction(pluginId, actionId) {
      if (!state) return null;
      for (var i = 0; i < state.actions.length; i++) {
        var action = state.actions[i];
        if (action.pluginId === pluginId && action.actionId === actionId) return action;
      }
      return null;
    }

    function selectedSlot() {
      if (!state || selectedKeyIndex === null) return null;
      for (var i = 0; i < state.slots.length; i++) {
        var slot = state.slots[i];
        if (slot.keyIndex === selectedKeyIndex && slot.deviceId === state.primaryDeviceId) return slot;
      }
      for (var j = 0; j < state.slots.length; j++) {
        if (state.slots[j].keyIndex === selectedKeyIndex) return state.slots[j];
      }
      return null;
    }

    function slotForKey(keyIndex) {
      if (!state) return null;
      for (var i = 0; i < state.slots.length; i++) {
        var slot = state.slots[i];
        if (slot.keyIndex === keyIndex && slot.deviceId === state.primaryDeviceId) return slot;
      }
      for (var j = 0; j < state.slots.length; j++) {
        if (state.slots[j].keyIndex === keyIndex) return state.slots[j];
      }
      return null;
    }

    function displayActionName(slot) {
      if (!slot) return "Empty";
      var action = findAction(slot.pluginId, slot.actionId);
      if (action) return action.name;
      var parts = slot.actionId.split(".");
      return parts[parts.length - 1] || slot.actionId;
    }

    function displayPluginName(slot) {
      if (!slot) return "-";
      var action = findAction(slot.pluginId, slot.actionId);
      return action ? action.pluginName : slot.pluginId;
    }

    function apiUrl(path) {
      var url = new URL(path, location.origin);
      if (window.DECKBRIDGE_WS_PORT) url.searchParams.set("wsPort", window.DECKBRIDGE_WS_PORT);
      return url;
    }

    async function loadState() {
      var response = await fetch(apiUrl("/api/state"));
      state = await response.json();
      if (selectedKeyIndex === null) {
        selectedKeyIndex = Math.min(31, Math.max(0, state.layout.totalKeys - 1));
      }
      render();
    }

    async function refreshLiveState() {
      if (draggingActionKey || draggingSlot || pointerTileDrag) return;
      if (liveRefreshInFlight) return;
      liveRefreshInFlight = true;
      try {
        var response = await fetch(apiUrl("/api/state"));
        state = await response.json();
        if (selectedKeyIndex === null) {
          selectedKeyIndex = Math.min(31, Math.max(0, state.layout.totalKeys - 1));
        }
        renderDeck();
        renderInspector();
        renderStatus();
      } finally {
        liveRefreshInFlight = false;
      }
    }

    function render() {
      renderActions();
      renderDeck();
      renderInspector();
      renderStatus();
    }

    function renderStatus() {
      byId("deckStatus").textContent = state.layout.columns + " x " + state.layout.rows + " / " + state.slots.length + " configured";
      byId("actionCount").textContent = state.actions.length + " available";
    }

    function renderActions() {
      var list = byId("actionList");
      list.textContent = "";
      var groups = {};
      var filter = searchValue.trim().toLowerCase();

      state.actions.forEach(function(action) {
        var haystack = (action.pluginName + " " + action.name + " " + action.actionId).toLowerCase();
        if (filter && haystack.indexOf(filter) === -1) return;
        if (!groups[action.pluginName]) groups[action.pluginName] = [];
        groups[action.pluginName].push(action);
      });

      Object.keys(groups).sort().forEach(function(pluginName) {
        var group = document.createElement("section");
        group.className = "plugin-group";

        var title = document.createElement("div");
        title.className = "plugin-name";
        title.textContent = pluginName;
        group.appendChild(title);

        groups[pluginName].forEach(function(action) {
          var button = document.createElement("div");
          button.className = "action" + (selectedActionKey === actionKey(action) ? " selected" : "");
          button.draggable = true;
          button.tabIndex = 0;
          button.setAttribute("role", "button");
          button.title = action.tooltip || action.actionId;

          var icon = document.createElement("div");
          icon.className = "action-icon";
          if (action.icon) {
            var img = document.createElement("img");
            img.src = "/" + action.pluginId + "/" + action.icon + ".png";
            img.alt = "";
            img.onerror = function() { icon.textContent = action.name.slice(0, 2).toUpperCase(); };
            icon.appendChild(img);
          } else {
            icon.textContent = action.name.slice(0, 2).toUpperCase();
          }

          var text = document.createElement("div");
          var name = document.createElement("div");
          name.className = "action-title";
          name.textContent = action.name;
          var sub = document.createElement("div");
          sub.className = "action-subtitle";
          sub.textContent = action.actionId;
          text.appendChild(name);
          text.appendChild(sub);

          button.appendChild(icon);
          button.appendChild(text);
          button.addEventListener("click", function() {
            selectedActionKey = actionKey(action);
            render();
          });
          button.addEventListener("keydown", function(event) {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            selectedActionKey = actionKey(action);
            render();
          });
          button.addEventListener("dragstart", function(event) {
            draggingActionKey = actionKey(action);
            selectedActionKey = draggingActionKey;
            event.currentTarget.classList.add("dragging");
            byId("deck").classList.add("dragging");
            event.dataTransfer.setData("application/x-deckbridge-action", draggingActionKey);
            event.dataTransfer.setData("text/plain", draggingActionKey);
            event.dataTransfer.effectAllowed = "copy";
            if (event.dataTransfer.setDragImage) {
              event.dataTransfer.setDragImage(event.currentTarget, 18, 18);
            }
            renderInspector();
          });
          button.addEventListener("dragend", function(event) {
            event.currentTarget.classList.remove("dragging");
            endDrag();
          });
          group.appendChild(button);
        });

        list.appendChild(group);
      });
    }

    function renderDeck() {
      var deck = byId("deck");
      deck.textContent = "";
      deck.style.gridTemplateColumns = "repeat(" + state.layout.columns + ", minmax(0, 1fr))";
      deck.classList.toggle("dragging", Boolean(draggingActionKey || draggingSlot));

      for (var i = 0; i < state.layout.totalKeys; i++) {
        var slot = slotForKey(i);
        var isMoving = draggingSlot && slot && draggingSlot.deviceId === slot.deviceId && draggingSlot.keyIndex === i;
        var key = document.createElement("button");
        var hasImage = slot && typeof slot.imageDataUrl === "string" && slot.imageDataUrl.length > 0;
        key.className = "key " + (slot ? "configured" : "empty") + (hasImage ? " has-image" : "") + (isMoving ? " moving" : "") + (selectedKeyIndex === i ? " selected" : "");
        key.title = slot ? slot.actionId : "Empty";
        key.dataset.keyIndex = String(i);
        key.draggable = false;

        if (hasImage) {
          var image = document.createElement("img");
          image.className = "key-image";
          image.src = slot.imageDataUrl;
          image.alt = displayActionName(slot);
          key.appendChild(image);
        } else {
          var num = document.createElement("div");
          num.className = "key-num";
          num.textContent = String(i);

          var label = document.createElement("div");
          label.className = "key-label";
          label.textContent = slot ? displayActionName(slot) : ((draggingActionKey || draggingSlot) ? "+" : "Empty");

          var plugin = document.createElement("div");
          plugin.className = "key-plugin";
          plugin.textContent = slot ? displayPluginName(slot) : "";

          key.appendChild(num);
          key.appendChild(label);
          key.appendChild(plugin);
        }
        key.addEventListener("click", activateKey.bind(null, i));
        key.addEventListener("contextmenu", openTileMenu.bind(null, i));
        key.addEventListener("pointerdown", handleTilePointerDown.bind(null, i));
        key.addEventListener("pointermove", handleTilePointerMove);
        key.addEventListener("pointerup", handleTilePointerUp);
        key.addEventListener("pointercancel", cancelTilePointerDrag);
        key.addEventListener("dragover", function(event) {
          event.preventDefault();
          closeTileMenu();
          event.currentTarget.classList.add("drag-over");
          if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        });
        key.addEventListener("dragleave", function(event) {
          event.currentTarget.classList.remove("drag-over");
        });
        key.addEventListener("drop", handleDrop.bind(null, i));
        deck.appendChild(key);
      }
    }

    function renderInspector() {
      var slot = selectedSlot();
      var action = slot ? findAction(slot.pluginId, slot.actionId) : null;
      byId("selectedKeyLabel").textContent = selectedKeyIndex === null ? "" : "Key " + selectedKeyIndex;
      byId("tileAction").textContent = slot ? displayActionName(slot) : "Empty";
      byId("tilePlugin").textContent = slot ? displayPluginName(slot) : "-";
      byId("tileContext").textContent = slot ? slot.context : "-";
      byId("assignBtn").disabled = selectedKeyIndex === null || selectedActionKey === null;
      byId("clearBtn").disabled = !slot;
      byId("openPiBtn").disabled = !slot || !slot.piUrl;
      if (action && !selectedActionKey) selectedActionKey = actionKey(action);
    }

    function selectKey(keyIndex) {
      selectedKeyIndex = keyIndex;
      render();
    }

    function activateKey(keyIndex) {
      if (Date.now() < suppressTileClickUntil) return;
      selectedKeyIndex = keyIndex;
      closeTileMenu();
      render();
      if (slotForKey(keyIndex)) openSelectedPI();
      else closePI();
    }

    function actionFromKey(key) {
      if (!key) return null;
      for (var i = 0; i < state.actions.length; i++) {
        if (actionKey(state.actions[i]) === key) return state.actions[i];
      }
      return null;
    }

    function clearDragOverState() {
      document.querySelectorAll(".key.drag-over").forEach(function(el) {
        el.classList.remove("drag-over");
      });
    }

    function endDrag() {
      removeFloatingTilePreview();
      draggingActionKey = null;
      draggingSlot = null;
      pointerTileDrag = null;
      byId("deck").classList.remove("dragging");
      clearDragOverState();
      renderActions();
      renderDeck();
      renderInspector();
    }

    function parseSlotDragPayload(event) {
      if (draggingSlot) return draggingSlot;
      if (!event.dataTransfer) return null;
      var raw = event.dataTransfer.getData("application/x-deckbridge-slot");
      if (!raw) return null;
      try {
        var parsed = JSON.parse(raw);
        if (typeof parsed.deviceId !== "string" || typeof parsed.keyIndex !== "number") return null;
        return parsed;
      } catch (err) {
        return null;
      }
    }

    function handleTileDragStart(keyIndex, event) {
      var slot = slotForKey(keyIndex);
      if (!slot) {
        event.preventDefault();
        return;
      }
      draggingSlot = { deviceId: slot.deviceId, keyIndex: keyIndex };
      selectedKeyIndex = keyIndex;
      closeTileMenu();
      byId("deck").classList.add("dragging");
      event.currentTarget.classList.add("moving");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-deckbridge-slot", JSON.stringify(draggingSlot));
        event.dataTransfer.setData("text/plain", "deckbridge-slot:" + slot.deviceId + ":" + keyIndex);
        if (event.dataTransfer.setDragImage) {
          event.dataTransfer.setDragImage(event.currentTarget, 18, 18);
        }
      }
      renderInspector();
    }

    function handleTilePointerDown(keyIndex, event) {
      if (event.button !== 0) return;
      var slot = slotForKey(keyIndex);
      if (!slot) return;
      pointerTileDrag = {
        source: { deviceId: slot.deviceId, keyIndex: keyIndex },
        startX: event.clientX,
        startY: event.clientY,
        offsetX: event.clientX - event.currentTarget.getBoundingClientRect().left,
        offsetY: event.clientY - event.currentTarget.getBoundingClientRect().top,
        active: false,
        element: event.currentTarget,
        pointerId: event.pointerId,
        preview: null
      };
      if (event.currentTarget.setPointerCapture) {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    }

    function dragTargetFromPoint(x, y) {
      var element = document.elementFromPoint(x, y);
      if (!element || !element.closest) return null;
      return element.closest(".key");
    }

    function createFloatingTilePreview() {
      if (!pointerTileDrag || pointerTileDrag.preview) return;
      var rect = pointerTileDrag.element.getBoundingClientRect();
      var preview = pointerTileDrag.element.cloneNode(true);
      preview.classList.remove("selected", "drag-over", "moving");
      preview.classList.add("floating-tile");
      preview.setAttribute("aria-hidden", "true");
      preview.style.width = rect.width + "px";
      preview.style.height = rect.height + "px";
      document.body.appendChild(preview);
      pointerTileDrag.preview = preview;
    }

    function updateFloatingTilePreview(x, y) {
      if (!pointerTileDrag || !pointerTileDrag.preview) return;
      pointerTileDrag.preview.style.left = (x - pointerTileDrag.offsetX) + "px";
      pointerTileDrag.preview.style.top = (y - pointerTileDrag.offsetY) + "px";
    }

    function removeFloatingTilePreview() {
      if (!pointerTileDrag || !pointerTileDrag.preview) return;
      pointerTileDrag.preview.remove();
      pointerTileDrag.preview = null;
    }

    function handleTilePointerMove(event) {
      if (!pointerTileDrag) return;
      var dx = event.clientX - pointerTileDrag.startX;
      var dy = event.clientY - pointerTileDrag.startY;

      if (!pointerTileDrag.active) {
        if (Math.sqrt(dx * dx + dy * dy) < 6) return;
        pointerTileDrag.active = true;
        draggingSlot = pointerTileDrag.source;
        selectedKeyIndex = draggingSlot.keyIndex;
        closeTileMenu();
        byId("deck").classList.add("dragging");
        pointerTileDrag.element.classList.add("moving");
        createFloatingTilePreview();
        renderInspector();
      }

      event.preventDefault();
      updateFloatingTilePreview(event.clientX, event.clientY);
      clearDragOverState();
      var target = dragTargetFromPoint(event.clientX, event.clientY);
      if (target) target.classList.add("drag-over");
    }

    async function handleTilePointerUp(event) {
      if (!pointerTileDrag) return;
      var drag = pointerTileDrag;
      if (drag.element.releasePointerCapture) {
        try { drag.element.releasePointerCapture(drag.pointerId); } catch (err) {}
      }

      if (!drag.active) {
        pointerTileDrag = null;
        return;
      }

      event.preventDefault();
      suppressTileClickUntil = Date.now() + 300;
      removeFloatingTilePreview();
      var target = dragTargetFromPoint(event.clientX, event.clientY);
      var targetKeyIndex = target ? Number(target.dataset.keyIndex) : NaN;

      if (Number.isInteger(targetKeyIndex)) {
        try {
          await moveTile(drag.source, targetKeyIndex);
        } catch (err) {
          render();
          byId("deckStatus").textContent = err instanceof Error ? err.message : String(err);
        }
      }

      endDrag();
    }

    function cancelTilePointerDrag() {
      if (!pointerTileDrag) return;
      suppressTileClickUntil = Date.now() + 300;
      removeFloatingTilePreview();
      endDrag();
    }

    async function moveTile(source, targetKeyIndex) {
      if (!source) return;
      if (source.deviceId === state.primaryDeviceId && source.keyIndex === targetKeyIndex) return;

      var response = await fetch(apiUrl("/api/slots/move"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceDeviceId: source.deviceId,
          sourceKeyIndex: source.keyIndex,
          targetDeviceId: state.primaryDeviceId,
          targetKeyIndex: targetKeyIndex
        })
      });
      if (!response.ok) {
        var message = await response.text();
        throw new Error(message || "Tile move failed");
      }
      selectedKeyIndex = targetKeyIndex;
      state = await response.json();
      render();
    }

    async function assignAction(action, keyIndex) {
      var targetKeyIndex = typeof keyIndex === "number" ? keyIndex : selectedKeyIndex;
      if (!action || targetKeyIndex === null) return;
      selectedKeyIndex = targetKeyIndex;
      var response = await fetch(apiUrl("/api/slots"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: state.primaryDeviceId,
          keyIndex: targetKeyIndex,
          pluginId: action.pluginId,
          actionId: action.actionId
        })
      });
      if (!response.ok) {
        var message = await response.text();
        throw new Error(message || "Tile assignment failed");
      }
      state = await response.json();
      render();
    }

    async function assignSelectedAction() {
      await assignAction(actionFromKey(selectedActionKey));
    }

    async function clearSelectedTile() {
      if (selectedKeyIndex === null) return;
      var url = apiUrl("/api/slots");
      url.searchParams.set("deviceId", state.primaryDeviceId);
      url.searchParams.set("keyIndex", String(selectedKeyIndex));
      var response = await fetch(url, { method: "DELETE" });
      state = await response.json();
      closePI();
      render();
    }

    async function handleDrop(keyIndex, event) {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.classList.remove("drag-over");
      closeTileMenu();
      selectedKeyIndex = keyIndex;
      var slotMove = parseSlotDragPayload(event);
      if (slotMove) {
        try {
          await moveTile(slotMove, keyIndex);
        } catch (err) {
          render();
          byId("deckStatus").textContent = err instanceof Error ? err.message : String(err);
        }
        suppressTileClickUntil = Date.now() + 250;
        endDrag();
        return;
      }

      var droppedActionKey = draggingActionKey;
      if (event.dataTransfer) {
        droppedActionKey = event.dataTransfer.getData("application/x-deckbridge-action") || event.dataTransfer.getData("text/plain") || droppedActionKey;
      }
      var action = actionFromKey(droppedActionKey);
      if (action) {
        selectedActionKey = actionKey(action);
        try {
          await assignAction(action, keyIndex);
        } catch (err) {
          render();
          byId("deckStatus").textContent = err instanceof Error ? err.message : String(err);
        }
      } else {
        render();
      }
      endDrag();
    }

    function openTileMenu(keyIndex, event) {
      event.preventDefault();
      selectedKeyIndex = keyIndex;
      renderDeck();
      renderInspector();

      var slot = slotForKey(keyIndex);
      if (!slot) {
        closeTileMenu();
        closePI();
        return;
      }

      contextMenuKeyIndex = keyIndex;
      var menu = byId("tileMenu");
      menu.classList.add("open");
      menu.setAttribute("aria-hidden", "false");
      byId("menuOpenPiBtn").disabled = !slot.piUrl;
      byId("menuRemoveBtn").disabled = false;

      var left = event.clientX;
      var top = event.clientY;
      var width = menu.offsetWidth;
      var height = menu.offsetHeight;
      if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
      if (top + height > window.innerHeight - 8) top = window.innerHeight - height - 8;
      menu.style.left = Math.max(8, left) + "px";
      menu.style.top = Math.max(8, top) + "px";
    }

    function closeTileMenu() {
      var menu = byId("tileMenu");
      menu.classList.remove("open");
      menu.setAttribute("aria-hidden", "true");
      contextMenuKeyIndex = null;
    }

    async function removeContextMenuTile() {
      if (contextMenuKeyIndex === null) return;
      selectedKeyIndex = contextMenuKeyIndex;
      closeTileMenu();
      await clearSelectedTile();
    }

    function openContextMenuPI() {
      if (contextMenuKeyIndex === null) return;
      selectedKeyIndex = contextMenuKeyIndex;
      closeTileMenu();
      renderInspector();
      openSelectedPI();
    }

    function openSelectedPI() {
      var slot = selectedSlot();
      if (!slot || !slot.piUrl) return;
      byId("piFrame").src = slot.piUrl;
      byId("piPanel").classList.add("open");
    }

    function closePI() {
      byId("piFrame").src = "about:blank";
      byId("piPanel").classList.remove("open");
    }

    byId("actionSearch").addEventListener("input", function(event) {
      searchValue = event.target.value;
      renderActions();
    });
    byId("refreshBtn").addEventListener("click", loadState);
    byId("assignBtn").addEventListener("click", assignSelectedAction);
    byId("clearBtn").addEventListener("click", clearSelectedTile);
    byId("openPiBtn").addEventListener("click", openSelectedPI);
    byId("closePiBtn").addEventListener("click", closePI);
    byId("menuOpenPiBtn").addEventListener("click", openContextMenuPI);
    byId("menuRemoveBtn").addEventListener("click", removeContextMenuTile);
    byId("tileMenu").addEventListener("click", function(event) {
      event.stopPropagation();
    });
    document.addEventListener("click", closeTileMenu);
    window.addEventListener("resize", closeTileMenu);
    window.addEventListener("scroll", closeTileMenu, true);
    window.addEventListener("keydown", function(event) {
      if ((event.key === "Delete" || event.key === "Backspace") && selectedSlot()) {
        clearSelectedTile();
      }
      if (event.key === "Escape") {
        closeTileMenu();
        closePI();
      }
    });

    loadState().catch(function(err) {
      byId("deckStatus").textContent = err.message || String(err);
    });
    window.setInterval(function() {
      refreshLiveState().catch(function(err) {
        byId("deckStatus").textContent = err.message || String(err);
      });
    }, 1000);
  </script>
</body>
</html>`

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  }
}
