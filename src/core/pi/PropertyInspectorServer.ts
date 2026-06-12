import { createServer, IncomingMessage, ServerResponse, Server } from 'http'
import { createReadStream, existsSync } from 'fs'
import { readFile, appendFile, mkdir, writeFile, mkdtemp, rm } from 'fs/promises'
import { join, extname, dirname, basename } from 'path'
import { homedir, tmpdir } from 'os'

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
  state?: number
  piFile: string
  imageDataUrl?: string
  feedback?: EncoderFeedbackDisplay
  isSystem?: boolean
}

export interface ActionEntry {
  pluginId: string
  pluginName: string
  actionId: string
  name: string
  tooltip: string
  icon?: string
  stateImages?: string[]
  piFile: string
  controllers?: Array<'Keypad' | 'Encoder'>
}

export interface InstalledPluginEntry {
  pluginId: string
  pluginName: string
  pluginDir: string
  actionCount: number
  running: boolean
}

export interface DeviceLayout {
  columns: number
  rows: number
  totalKeys: number
}

export interface DeviceSummary {
  id: string
  name: string
  model: string
  type: number
  columns: number
  rows: number
  totalKeys: number
  dials?: number
}

export interface ViewState {
  inFolder: boolean
  folderId?: string
  navDepth: number
}

export interface FolderSettingsUpdate {
  deviceId: string
  keyIndex: number
  folderName?: string
  folderColor?: string
}

export interface SlotAssignment {
  deviceId: string
  keyIndex: number
  pluginId: string
  actionId: string
  settings?: Record<string, unknown>
}

export interface SlotMove {
  sourceDeviceId: string
  sourceKeyIndex: number
  targetDeviceId: string
  targetKeyIndex: number
}

export interface DialEventRequest {
  deviceId: string
  dialIndex: number
  ticks?: number
  pressed?: boolean
  hold?: boolean
  tapPos?: [number, number]
  state?: 'down' | 'up'   // dial press: send only dialDown or only dialUp (for hold)
}

export interface EncoderFeedbackDisplay {
  layout?: string
  imageDataUrl?: string
  title?: string
  value?: string
  indicator?: unknown
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export class PropertyInspectorServer {
  private server: Server | null = null
  private port: number = 0
  private pluginBaseDir: string = ''
  private slotProvider: (() => SlotEntry[]) | null = null
  private actionProvider: (() => ActionEntry[]) | null = null
  private installedPluginProvider: (() => InstalledPluginEntry[]) | null = null
  private layoutProvider: (() => DeviceLayout) | null = null
  private devicesProvider: (() => DeviceSummary[]) | null = null
  private primaryDeviceProvider: (() => string | null) | null = null
  private selectDeviceHandler: ((deviceId: string) => Promise<void> | void) | null = null
  private assignSlotHandler: ((assignment: SlotAssignment) => Promise<void> | void) | null = null
  private clearSlotHandler: ((deviceId: string, keyIndex: number) => Promise<void> | void) | null = null
  private moveSlotHandler: ((move: SlotMove) => Promise<void> | void) | null = null
  private switchPageHandler: ((pageIndex: number) => Promise<void> | void) | null = null
  private addPageHandler: ((afterIndex?: number) => Promise<number> | number) | null = null
  private removePageHandler: ((pageIndex: number) => Promise<void> | void) | null = null
  private pageProvider: (() => { activePage: number; pageCount: number }) | null = null
  private createFolderHandler: ((deviceId: string, keyIndex: number) => Promise<string> | string) | null = null
  private enterFolderHandler: ((folderId: string) => Promise<void> | void) | null = null
  private exitFolderHandler: (() => Promise<void> | void) | null = null
  private updateFolderSettingsHandler: ((update: FolderSettingsUpdate) => Promise<void> | void) | null = null
  private viewProvider: (() => ViewState) | null = null
  private undoHandler: (() => Promise<boolean> | boolean) | null = null
  private redoHandler: (() => Promise<boolean> | boolean) | null = null
  private undoStateProvider: (() => { canUndo: boolean; canRedo: boolean }) | null = null
  private brightnessHandler: ((deviceId: string, value: number) => Promise<void> | void) | null = null
  private brightnessProvider: ((deviceId: string) => number) | null = null
  private dialRotateHandler: ((request: DialEventRequest) => Promise<void> | void) | null = null
  private dialPressHandler: ((request: DialEventRequest) => Promise<void> | void) | null = null
  private dialTouchHandler: ((request: DialEventRequest) => Promise<void> | void) | null = null
  private installPluginHandler: ((sourcePath: string) => Promise<void> | void) | null = null
  private uninstallPluginHandler: ((pluginId: string) => Promise<void> | void) | null = null
  private readonly debugPI: boolean = process.env.DECKBRIDGE_DEBUG_PI === '1'
  private readonly debugPILogPath: string = process.env.DECKBRIDGE_DEBUG_PI_LOG || join(homedir(), '.config', 'DeckBridge', 'logs', 'pi-debug.log')
  private readonly preferredPort: number = Number(process.env.DECKBRIDGE_PI_PORT ?? 34075)
  private lastStateDebugSig = ''
  private debugLogReady = false

  private logPIDebug(source: string, payload: unknown): void {
    if (!this.debugPI) return
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      source,
      payload,
    })
    void this.writePIDebugLine(entry)
  }

  private async writePIDebugLine(line: string): Promise<void> {
    try {
      if (!this.debugLogReady) {
        await mkdir(dirname(this.debugPILogPath), { recursive: true })
        this.debugLogReady = true
      }
      await appendFile(this.debugPILogPath, `${line}\n`, 'utf8')
    } catch {
      // Intentionally ignore debug logging failures.
    }
  }

  setSlotProvider(fn: () => SlotEntry[]): void {
    this.slotProvider = fn
  }

  setActionProvider(fn: () => ActionEntry[]): void {
    this.actionProvider = fn
  }

  setInstalledPluginProvider(fn: () => InstalledPluginEntry[]): void {
    this.installedPluginProvider = fn
  }

  setLayoutProvider(fn: () => DeviceLayout): void {
    this.layoutProvider = fn
  }

  setDevicesProvider(fn: () => DeviceSummary[]): void {
    this.devicesProvider = fn
  }

  setPrimaryDeviceProvider(fn: () => string | null): void {
    this.primaryDeviceProvider = fn
  }

  setDeviceSelectionHandler(fn: (deviceId: string) => Promise<void> | void): void {
    this.selectDeviceHandler = fn
  }

  setSlotMutationHandlers(handlers: {
    assign: (assignment: SlotAssignment) => Promise<void> | void
    clear: (deviceId: string, keyIndex: number) => Promise<void> | void
    move?: (move: SlotMove) => Promise<void> | void
    switchPage?: (pageIndex: number) => Promise<void> | void
    addPage?: (afterIndex?: number) => Promise<number> | number
    removePage?: (pageIndex: number) => Promise<void> | void
  }): void {
    this.assignSlotHandler = handlers.assign
    this.clearSlotHandler = handlers.clear
    this.moveSlotHandler = handlers.move ?? null
    this.switchPageHandler = handlers.switchPage ?? null
    this.addPageHandler = handlers.addPage ?? null
    this.removePageHandler = handlers.removePage ?? null
  }

  setPageProvider(fn: () => { activePage: number; pageCount: number }): void {
    this.pageProvider = fn
  }

  setFolderHandlers(handlers: {
    create: (deviceId: string, keyIndex: number) => Promise<string> | string
    enter: (folderId: string) => Promise<void> | void
    exit: () => Promise<void> | void
    updateSettings?: (update: FolderSettingsUpdate) => Promise<void> | void
  }): void {
    this.createFolderHandler = handlers.create
    this.enterFolderHandler = handlers.enter
    this.exitFolderHandler = handlers.exit
    this.updateFolderSettingsHandler = handlers.updateSettings ?? null
  }

  setViewProvider(fn: () => ViewState): void {
    this.viewProvider = fn
  }

  setUndoRedoHandlers(handlers: {
    undo: () => Promise<boolean> | boolean
    redo: () => Promise<boolean> | boolean
    state: () => { canUndo: boolean; canRedo: boolean }
  }): void {
    this.undoHandler = handlers.undo
    this.redoHandler = handlers.redo
    this.undoStateProvider = handlers.state
  }

  setBrightnessHandlers(handlers: {
    set: (deviceId: string, value: number) => Promise<void> | void
    get: (deviceId: string) => number
  }): void {
    this.brightnessHandler = handlers.set
    this.brightnessProvider = handlers.get
  }

  setDialHandlers(handlers: {
    rotate: (request: DialEventRequest) => Promise<void> | void
    press: (request: DialEventRequest) => Promise<void> | void
    touch?: (request: DialEventRequest) => Promise<void> | void
  }): void {
    this.dialRotateHandler = handlers.rotate
    this.dialPressHandler = handlers.press
    this.dialTouchHandler = handlers.touch ?? null
  }

  setPluginManagementHandlers(handlers: {
    install: (sourcePath: string) => Promise<void> | void
    uninstall: (pluginId: string) => Promise<void> | void
  }): void {
    this.installPluginHandler = handlers.install
    this.uninstallPluginHandler = handlers.uninstall
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

    const requestedPort = Number.isInteger(this.preferredPort) && this.preferredPort > 0 ? this.preferredPort : 34075
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(requestedPort, '0.0.0.0', () => {
        this.port = (this.server!.address() as { port: number }).port
        console.log(`PI server op poort ${this.port}`)
        resolve()
      })
    })

    if (this.debugPI) {
      this.logPIDebug('server-start', { port: this.port, logPath: this.debugPILogPath })
    }
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }

  getPort(): number {
    return this.port
  }

  getHttpServer(): Server | null {
    return this.server
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
    // Relative URL so the PI iframe (and its WebSocket via location.hostname)
    // inherit the host the dashboard was loaded from — e.g. the WSL IP — instead
    // of being pinned to 127.0.0.1 and routed back through the WSL2 relay.
    const url = `/${slot.pluginId}/${piFile}?${params}`
    this.logPIDebug('pi-url', {
      keyIndex: slot.keyIndex,
      deviceId: slot.deviceId,
      actionId: slot.actionId,
      context: slot.context,
      pluginId: slot.pluginId,
      piFile,
      wsPort,
    })
    return url
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`)
    console.log(`[HTTP] ${req.method} ${url.pathname} from ${req.socket.remoteAddress}`)
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

    if (url.pathname === '/api/images' && req.method === 'GET') {
      const images = (this.slotProvider?.() ?? [])
        .filter(s => {
          const hasKeyImage = typeof s.imageDataUrl === 'string' && s.imageDataUrl.length > 0
          const hasFeedbackImage = typeof s.feedback?.imageDataUrl === 'string' && s.feedback.imageDataUrl.length > 0
          return hasKeyImage || hasFeedbackImage
        })
        .map(s => ({
          deviceId: s.deviceId,
          keyIndex: s.keyIndex,
          imageDataUrl: s.imageDataUrl,
          feedbackImageDataUrl: s.feedback?.imageDataUrl,
        }))
      this.sendJson(res, 200, images)
      return
    }

    if (url.pathname === '/api/debug/pi' && req.method === 'POST') {
      await this.handleClientPIDebug(req, res)
      return
    }

    if (url.pathname === '/api/plugins/install' && req.method === 'POST') {
      await this.handleInstallPlugin(req, res, url)
      return
    }

    if (url.pathname === '/api/plugins/upload' && req.method === 'POST') {
      await this.handleUploadPlugin(req, res, url)
      return
    }

    if (url.pathname === '/api/plugins/uninstall' && req.method === 'POST') {
      await this.handleUninstallPlugin(req, res, url)
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

    if (url.pathname === '/api/pages/switch' && req.method === 'POST') {
      await this.handleSwitchPage(req, res, url)
      return
    }

    if (url.pathname === '/api/pages/add' && req.method === 'POST') {
      await this.handleAddPage(req, res, url)
      return
    }

    if (url.pathname === '/api/pages/remove' && req.method === 'POST') {
      await this.handleRemovePage(req, res, url)
      return
    }

    if (url.pathname === '/api/folders/create' && req.method === 'POST') {
      await this.handleCreateFolder(req, res, url)
      return
    }

    if (url.pathname === '/api/folders/enter' && req.method === 'POST') {
      await this.handleEnterFolder(req, res, url)
      return
    }

    if (url.pathname === '/api/folders/exit' && req.method === 'POST') {
      await this.handleExitFolder(res, url)
      return
    }

    if (url.pathname === '/api/folders/settings' && req.method === 'POST') {
      await this.handleUpdateFolderSettings(req, res, url)
      return
    }

    if (url.pathname === '/api/profile/undo' && req.method === 'POST') {
      await this.handleUndo(res)
      return
    }

    if (url.pathname === '/api/profile/redo' && req.method === 'POST') {
      await this.handleRedo(res)
      return
    }

    if (url.pathname === '/api/device/brightness' && req.method === 'POST') {
      await this.handleSetBrightness(req, res)
      return
    }

    if (url.pathname === '/api/device/select' && req.method === 'POST') {
      await this.handleSelectDevice(req, res, url)
      return
    }

    if (url.pathname === '/api/dials/rotate' && req.method === 'POST') {
      await this.handleDialRotate(req, res)
      return
    }

    if (url.pathname === '/api/dials/press' && req.method === 'POST') {
      await this.handleDialPress(req, res)
      return
    }

    if (url.pathname === '/api/dials/touch' && req.method === 'POST') {
      await this.handleDialTouch(req, res)
      return
    }

    if (url.pathname === '/system/folder-editor' && req.method === 'GET') {
      this.serveFolderEditor(res, url)
      return
    }

    if (url.pathname.startsWith('/api/')) {
      res.writeHead(404)
      res.end('Not Found')
      return
    }

    this.servePluginFile(url, res)
  }

  private async handleClientPIDebug(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.debugPI) {
      this.sendJson(res, 204, { ok: true })
      return
    }
    try {
      const body = await this.readJson(req)
      this.logPIDebug('dashboard', body)
      this.sendJson(res, 200, { ok: true })
    } catch (err) {
      this.sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'Invalid debug payload' })
    }
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
    // The plugin WS shares this HTTP server's port; always use our own port so
    // PI iframe URLs never point at a stale ?wsPort= that WSL2 won't forward.
    void url
    const wsPort = this.port
    const slots = this.slotProvider?.() ?? []
    const actions = this.actionProvider?.() ?? []
    const installedPlugins = this.installedPluginProvider?.() ?? []
    const layout = this.layoutProvider?.() ?? { columns: 8, rows: 4, totalKeys: 32 }
    const primaryDeviceId = this.primaryDeviceProvider?.() ?? null
    const devices = this.devicesProvider?.() ?? []

    const pages = this.pageProvider?.() ?? { activePage: 0, pageCount: 1 }
    const view = this.viewProvider?.() ?? { inFolder: false, navDepth: 0 }

    const payload = {
      primaryDeviceId,
      devices,
      layout,
      actions,
      installedPlugins,
      activePage: pages.activePage,
      pageCount: pages.pageCount,
      view,
      canUndo: this.undoStateProvider?.().canUndo ?? false,
      canRedo: this.undoStateProvider?.().canRedo ?? false,
      brightness: this.brightnessProvider && primaryDeviceId ? this.brightnessProvider(primaryDeviceId) : 70,
      slots: slots.map((slot) => ({
        ...slot,
        piUrl: wsPort && slot.piFile ? this.getUrl(slot, slot.piFile, wsPort) : '',
      })),
    }
    const sig = `${wsPort}|${primaryDeviceId}|${pages.activePage}|${view.inFolder ? 1 : 0}|${view.navDepth}|${payload.slots.length}`
    if (sig !== this.lastStateDebugSig) {
      this.lastStateDebugSig = sig
      this.logPIDebug('state', {
        wsPort,
        primaryDeviceId,
        activePage: pages.activePage,
        inFolder: view.inFolder,
        navDepth: view.navDepth,
        selectedSlots: payload.slots.length,
      })
    }
    return payload
  }

  private async handleInstallPlugin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.installPluginHandler) { this.sendJson(res, 501, { error: 'Not configured' }); return }
    try {
      const body = await this.readJson(req)
      const sourcePath = isRecord(body) && typeof body.path === 'string' ? body.path.trim() : ''
      if (!sourcePath) throw new Error('Missing plugin path')
      await this.installPluginHandler(sourcePath)
      this.sendJson(res, 200, this.getState(url))
    } catch (err) {
      this.sendJson(res, 400, { error: err instanceof Error ? err.message : 'Install failed' })
    }
  }

  private async handleUploadPlugin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.installPluginHandler) { this.sendJson(res, 501, { error: 'Not configured' }); return }
    const rawName = url.searchParams.get('filename') ?? 'plugin.streamDeckPlugin'
    const filename = basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '-')
    if (!filename.endsWith('.streamDeckPlugin') && !filename.endsWith('.zip')) {
      this.sendJson(res, 400, { error: 'Expected .streamDeckPlugin or .zip file' })
      return
    }

    const tempRoot = await mkdtemp(join(tmpdir(), 'deckbridge-upload-'))
    const uploadPath = join(tempRoot, filename)
    try {
      await writeFile(uploadPath, await this.readRaw(req, 250 * 1024 * 1024))
      await this.installPluginHandler(uploadPath)
      this.sendJson(res, 200, this.getState(url))
    } catch (err) {
      this.sendJson(res, 400, { error: err instanceof Error ? err.message : 'Upload install failed' })
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  }

  private async handleUninstallPlugin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.uninstallPluginHandler) { this.sendJson(res, 501, { error: 'Not configured' }); return }
    try {
      const body = await this.readJson(req)
      const pluginId = isRecord(body) && typeof body.pluginId === 'string' ? body.pluginId.trim() : ''
      if (!pluginId) throw new Error('Missing pluginId')
      await this.uninstallPluginHandler(pluginId)
      this.sendJson(res, 200, this.getState(url))
    } catch (err) {
      this.sendJson(res, 400, { error: err instanceof Error ? err.message : 'Uninstall failed' })
    }
  }

  private async handleSelectDevice(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.selectDeviceHandler) { this.sendJson(res, 501, { error: 'Not configured' }); return }
    const body = await this.readJson(req)
    const deviceId = typeof (body as Record<string, unknown>).deviceId === 'string'
      ? (body as Record<string, unknown>).deviceId as string
      : ''
    if (!deviceId) {
      this.sendJson(res, 400, { error: 'Invalid deviceId' })
      return
    }
    await this.selectDeviceHandler(deviceId)
    this.sendJson(res, 200, this.getState(url))
  }

  private parseDialRequest(body: unknown): DialEventRequest {
    if (!isRecord(body)) throw new Error('Expected a JSON object')
    const deviceId = typeof body.deviceId === 'string' && body.deviceId
      ? body.deviceId
      : this.primaryDeviceProvider?.()
    const dialIndex = Number(body.dialIndex)
    if (!deviceId) throw new Error('Missing deviceId')
    if (!Number.isInteger(dialIndex) || dialIndex < 0) throw new Error('Invalid dialIndex')
    const device = this.devicesProvider?.().find((candidate) => candidate.id === deviceId)
    if (device && Number.isInteger(device.dials) && dialIndex >= (device.dials ?? 0)) {
      throw new Error('Invalid dialIndex')
    }
    const ticks = Number(body.ticks)
    const pressed = Boolean(body.pressed)
    const rawTapPos = Array.isArray(body.tapPos) ? body.tapPos : undefined
    const tapX = rawTapPos ? Number(rawTapPos[0]) : NaN
    const tapY = rawTapPos ? Number(rawTapPos[1]) : NaN
    return {
      deviceId,
      dialIndex,
      ticks: Number.isFinite(ticks) && ticks !== 0 ? Math.trunc(ticks) : undefined,
      pressed,
      hold: Boolean(body.hold),
      tapPos: Number.isFinite(tapX) && Number.isFinite(tapY) ? [Math.trunc(tapX), Math.trunc(tapY)] : undefined,
    }
  }

  private async handleDialRotate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.dialRotateHandler) { this.sendJson(res, 501, { error: 'Not configured' }); return }
    try {
      const request = this.parseDialRequest(await this.readJson(req))
      await this.dialRotateHandler(request)
      this.sendJson(res, 200, { ok: true })
    } catch (err) {
      this.sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid request' })
    }
  }

  private async handleDialPress(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.dialPressHandler) { this.sendJson(res, 501, { error: 'Not configured' }); return }
    try {
      const request = this.parseDialRequest(await this.readJson(req))
      await this.dialPressHandler(request)
      this.sendJson(res, 200, { ok: true })
    } catch (err) {
      this.sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid request' })
    }
  }

  private async handleDialTouch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.dialTouchHandler) { this.sendJson(res, 501, { error: 'Not configured' }); return }
    try {
      const request = this.parseDialRequest(await this.readJson(req))
      await this.dialTouchHandler(request)
      this.sendJson(res, 200, { ok: true })
    } catch (err) {
      this.sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid request' })
    }
  }

  private async handleCreateFolder(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.createFolderHandler) { this.sendJson(res, 501, { error: 'Not configured' }); return }
    const body = await this.readJson(req)
    const keyIndex = Number((body as Record<string, unknown>).keyIndex)
    const deviceId = typeof (body as Record<string, unknown>).deviceId === 'string'
      ? (body as Record<string, unknown>).deviceId as string
      : this.primaryDeviceProvider?.()
    if (!deviceId || !Number.isInteger(keyIndex) || keyIndex < 0) {
      this.sendJson(res, 400, { error: 'Invalid deviceId or keyIndex' })
      return
    }
    const target = this.slotProvider?.().find(s => s.deviceId === deviceId && s.keyIndex === keyIndex)
    if (target?.isSystem) {
      this.sendJson(res, 403, { error: 'System slot' })
      return
    }
    await this.createFolderHandler(deviceId, keyIndex)
    this.sendJson(res, 200, this.getState(url))
  }

  private async handleEnterFolder(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.enterFolderHandler) { this.sendJson(res, 501, { error: 'Not configured' }); return }
    const body = await this.readJson(req)
    const folderId = typeof (body as Record<string, unknown>).folderId === 'string'
      ? (body as Record<string, unknown>).folderId as string
      : ''
    if (!folderId) {
      this.sendJson(res, 400, { error: 'Invalid folderId' })
      return
    }
    await this.enterFolderHandler(folderId)
    this.sendJson(res, 200, this.getState(url))
  }

  private async handleExitFolder(res: ServerResponse, url: URL): Promise<void> {
    if (!this.exitFolderHandler) { this.sendJson(res, 501, { error: 'Not configured' }); return }
    await this.exitFolderHandler()
    this.sendJson(res, 200, this.getState(url))
  }

  private async handleUpdateFolderSettings(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.updateFolderSettingsHandler) { this.sendJson(res, 501, { error: 'Not configured' }); return }
    const body = await this.readJson(req)
    const keyIndex = Number((body as Record<string, unknown>).keyIndex)
    const deviceId = typeof (body as Record<string, unknown>).deviceId === 'string'
      ? (body as Record<string, unknown>).deviceId as string
      : this.primaryDeviceProvider?.()
    if (!deviceId || !Number.isInteger(keyIndex) || keyIndex < 0) {
      this.sendJson(res, 400, { error: 'Invalid deviceId or keyIndex' })
      return
    }
    const folderName = typeof (body as Record<string, unknown>).folderName === 'string'
      ? (body as Record<string, unknown>).folderName as string
      : undefined
    const folderColor = typeof (body as Record<string, unknown>).folderColor === 'string'
      ? (body as Record<string, unknown>).folderColor as string
      : undefined
    await this.updateFolderSettingsHandler({ deviceId, keyIndex, folderName, folderColor })
    this.sendJson(res, 200, this.getState(url))
  }

  private async handleSetBrightness(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.brightnessHandler) { this.sendJson(res, 501, { error: 'Not configured' }); return }
    const body = await this.readJson(req)
    const deviceId = typeof (body as Record<string, unknown>).deviceId === 'string'
      ? (body as Record<string, unknown>).deviceId as string
      : (this.primaryDeviceProvider?.() ?? '')
    const value = Number((body as Record<string, unknown>).value)
    if (!deviceId || !Number.isFinite(value) || value < 0 || value > 100) {
      this.sendJson(res, 400, { error: 'Invalid deviceId or value (0-100)' }); return
    }
    await this.brightnessHandler(deviceId, Math.round(value))
    this.sendJson(res, 200, { ok: true, brightness: Math.round(value) })
  }

  private async handleUndo(res: ServerResponse): Promise<void> {
    if (!this.undoHandler) { this.sendJson(res, 501, { error: 'Not configured' }); return }
    const ok = await this.undoHandler()
    this.sendJson(res, 200, { ok, ...(this.undoStateProvider?.() ?? {}) })
  }

  private async handleRedo(res: ServerResponse): Promise<void> {
    if (!this.redoHandler) { this.sendJson(res, 501, { error: 'Not configured' }); return }
    const ok = await this.redoHandler()
    this.sendJson(res, 200, { ok, ...(this.undoStateProvider?.() ?? {}) })
  }

  private serveFolderEditor(res: ServerResponse, url: URL): void {
    const deviceId = url.searchParams.get('deviceId') ?? ''
    const keyIndex = url.searchParams.get('keyIndex') ?? ''
    const folderName = url.searchParams.get('folderName') ?? 'Folder'
    const folderColor = url.searchParams.get('folderColor') ?? '#7f8694'

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Folder Settings</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; background: #14181d; color: #e6edf3; }
    .wrap { padding: 16px; display: grid; gap: 12px; }
    .row { display: grid; gap: 6px; }
    label { font-size: 12px; color: #9fb0c0; }
    input { height: 34px; border-radius: 6px; border: 1px solid #2f3a46; background: #0f1317; color: #e6edf3; padding: 0 10px; }
    input[type=color] { padding: 0; width: 72px; }
    button { height: 36px; border-radius: 7px; border: 1px solid #2d8155; background: #163724; color: #d7f6e6; cursor: pointer; }
    .status { font-size: 12px; color: #9fb0c0; min-height: 16px; }
  </style>
</head>
<body>
  <main class="wrap">
    <div class="row">
      <label for="name">Folder Name</label>
      <input id="name" maxlength="24" value="${escapeHtml(folderName)}" />
    </div>
    <div class="row">
      <label for="color">Folder Color</label>
      <input id="color" type="color" value="${escapeHtml(folderColor)}" />
    </div>
    <button id="save">Save</button>
    <div class="status" id="status"></div>
  </main>
  <script>
    const byId = (id) => document.getElementById(id)
    byId('save').addEventListener('click', async () => {
      const name = byId('name').value.trim() || 'Folder'
      const color = byId('color').value || '#7f8694'
      const status = byId('status')
      status.textContent = 'Saving...'
      const res = await fetch('/api/folders/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: ${JSON.stringify(deviceId)}, keyIndex: Number(${JSON.stringify(keyIndex)}), folderName: name, folderColor: color }),
      })
      status.textContent = res.ok ? 'Saved' : 'Save failed'
    })
  </script>
</body>
</html>`

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  }

  private async handleSwitchPage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.switchPageHandler) { this.sendJson(res, 501, { error: 'Not configured' }); return }
    const body = await this.readJson(req)
    const pageIndex = typeof (body as Record<string, unknown>).pageIndex === 'number'
      ? (body as Record<string, unknown>).pageIndex as number
      : -1
    if (pageIndex < 0) { this.sendJson(res, 400, { error: 'Invalid pageIndex' }); return }
    await this.switchPageHandler(pageIndex)
    this.sendJson(res, 200, this.getState(url))
  }

  private async handleAddPage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.addPageHandler) { this.sendJson(res, 501, { error: 'Not configured' }); return }
    const body = await this.readJson(req)
    const afterIndex = typeof (body as Record<string, unknown>).afterIndex === 'number'
      ? (body as Record<string, unknown>).afterIndex as number
      : undefined
    await this.addPageHandler(afterIndex)
    this.sendJson(res, 200, this.getState(url))
  }

  private async handleRemovePage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.removePageHandler) { this.sendJson(res, 501, { error: 'Not configured' }); return }
    const body = await this.readJson(req)
    const pageIndex = typeof (body as Record<string, unknown>).pageIndex === 'number'
      ? (body as Record<string, unknown>).pageIndex as number
      : -1
    if (pageIndex < 0) { this.sendJson(res, 400, { error: 'Invalid pageIndex' }); return }
    const pages = this.pageProvider?.() ?? { activePage: 0, pageCount: 1 }
    if (pages.pageCount <= 1) { this.sendJson(res, 400, { error: 'Cannot remove last page' }); return }
    await this.removePageHandler(pageIndex)
    this.sendJson(res, 200, this.getState(url))
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

    const target = this.slotProvider?.().find(s => s.deviceId === assignment.deviceId && s.keyIndex === assignment.keyIndex)
    if (target?.isSystem) {
      this.sendJson(res, 403, { error: 'System slot' })
      return
    }
    try {
      await this.assignSlotHandler(assignment)
      this.sendJson(res, 200, this.getState(url))
    } catch (err) {
      this.sendJson(res, 400, { error: err instanceof Error ? err.message : 'Assignment failed' })
    }
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

    const slot = this.slotProvider?.().find(s => s.deviceId === deviceId && s.keyIndex === keyIndex)
    if (slot?.isSystem) {
      this.sendJson(res, 403, { error: 'System slot' })
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

    const moveTarget = this.slotProvider?.().find(s => s.deviceId === move.targetDeviceId && s.keyIndex === move.targetKeyIndex)
    if (moveTarget?.isSystem) {
      this.sendJson(res, 403, { error: 'System slot' })
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

    const settings = isRecord(body.settings) ? body.settings as Record<string, unknown> : undefined
    return { deviceId, keyIndex, pluginId, actionId, settings }
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
    const raw = (await this.readRaw(req, 1024 * 1024)).toString('utf8')
    return raw ? JSON.parse(raw) : {}
  }

  private async readRaw(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += buffer.length
      if (length > maxBytes) throw new Error('Request body too large')
      chunks.push(buffer)
    }
    return Buffer.concat(chunks)
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
  }

  private serveDashboard(res: ServerResponse, url: URL): void {
    // The plugin WS shares this HTTP server's port, so always use our own port
    // regardless of any stale ?wsPort= in the URL the browser still has.
    const wsPort = JSON.stringify(String(this.port))
    void url
    const debugPI = this.debugPI ? 'true' : 'false'
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
    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .error-banner {
      position: fixed;
      bottom: 18px;
      left: 50%;
      transform: translateX(-50%);
      background: #5c1d1d;
      border: 1px solid #a33030;
      color: #f5c6c6;
      font-size: 13px;
      padding: 10px 18px;
      border-radius: 8px;
      z-index: 9999;
      display: none;
      max-width: min(480px, 90vw);
      word-break: break-word;
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
    }
    .error-banner.visible { display: flex; gap: 12px; align-items: center; }
    .error-banner-close { background: none; border: none; color: #f5c6c6; font-size: 18px; cursor: pointer; padding: 0; line-height: 1; min-height: unset; }
    .crumb-bar {
      padding: 8px 18px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 44px;
    }
    .crumb-back {
      min-height: 30px;
      padding: 0 10px;
      font-size: 12px;
      border-color: #8f6b2b;
      background: #2f2718;
      color: #f1cb80;
    }
    .breadcrumb {
      color: #cdd9e5;
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
      padding: 28px 28px 12px;
    }
    .page-bar {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 0 28px 8px;
    }
    .device-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 28px 16px;
      border-top: 1px solid var(--line);
      padding-top: 10px;
    }
    .device-bar-label {
      font-size: 11px;
      color: var(--muted);
      white-space: nowrap;
      min-width: 68px;
    }
    .device-select {
      min-width: 160px;
      max-width: 240px;
      height: 32px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #0f1113;
      color: var(--text);
      padding: 0 8px;
      font: inherit;
      font-size: 12px;
    }
    .brightness-slider {
      flex: 1;
      accent-color: var(--accent);
      cursor: pointer;
      height: 4px;
    }
    .device-bar-value {
      font-size: 11px;
      color: var(--text);
      min-width: 32px;
      text-align: right;
    }
    .page-tabs {
      display: flex;
      gap: 4px;
      overflow-x: auto;
      flex-wrap: wrap;
      max-width: calc(100% - 60px);
    }
    .page-tab {
      padding: 4px 0;
      width: 64px;
      text-align: center;
      border-radius: 5px;
      border: 1px solid #303841;
      background: #1c2128;
      color: #8d98a5;
      font-size: 12px;
      cursor: pointer;
      min-height: unset;
      margin-right: 4px;
      margin-bottom: 4px;
    }
    .page-tab:hover { border-color: #4a6fa5; color: #cdd9e5; }
    .page-tab.active { background: #1f6feb22; border-color: #1f6feb; color: #79c0ff; font-weight: 600; }
    .page-add {
      padding: 4px 10px;
      border-radius: 5px;
      border: 1px dashed #303841;
      background: transparent;
      color: #8d98a5;
      font-size: 14px;
      cursor: pointer;
      min-height: unset;
      margin-left: 6px;
    }
    .page-add:hover { border-color: #4a6fa5; color: #cdd9e5; }
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
    .dial-strip {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      padding-top: 2px;
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
    .dial {
      aspect-ratio: 1.45;
      grid-template-rows: 18px minmax(0, 1fr) 30px;
    }
    .dial.has-feedback {
      grid-template-rows: minmax(0, 1fr) 30px;
    }
    .dial.has-feedback .key-num {
      display: none;
    }
    .dial .key-label {
      min-height: 0;
      overflow: hidden;
    }
    .dial-feedback-image {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
      background: #000;
      border-radius: 4px;
    }
    .dial-controls {
      display: grid;
      grid-template-columns: 30px minmax(0, 1fr) 44px 30px;
      gap: 5px;
      align-items: center;
    }
    .dial-controls button {
      min-height: 28px;
      height: 28px;
      padding: 0;
      border-radius: 6px;
      font-size: 13px;
    }
    .dial-press {
      font-size: 11px !important;
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
    .key.folder {
      background: linear-gradient(180deg, #252a32, #171b20);
      border-color: #5a6676;
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
    .plugin-admin {
      border-top: 1px solid var(--line);
      padding-top: 14px;
      display: grid;
      gap: 10px;
    }
    .plugin-admin-title {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .plugin-dropzone {
      border: 1px dashed #46525f;
      border-radius: 8px;
      background: #101419;
      min-height: 78px;
      padding: 12px;
      display: grid;
      place-items: center;
      text-align: center;
      gap: 6px;
      color: var(--text);
    }
    .plugin-dropzone.drag-over {
      border-color: var(--accent);
      background: #132019;
    }
    .plugin-drop-main {
      font-size: 13px;
      font-weight: 650;
    }
    .plugin-drop-sub {
      color: var(--muted);
      font-size: 11px;
    }
    .plugin-admin input[type=file] {
      display: none;
    }
    .plugin-install-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 76px;
      gap: 8px;
    }
    .plugin-install-row.compact {
      grid-template-columns: minmax(0, 1fr) 64px;
    }
    .plugin-path {
      min-width: 0;
      height: 36px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #0f1113;
      color: var(--text);
      padding: 0 10px;
      outline: none;
    }
    .plugin-path:focus {
      border-color: var(--accent-2);
    }
    .plugin-list {
      display: grid;
      gap: 7px;
    }
    .plugin-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 78px;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #121619;
      padding: 8px;
    }
    .plugin-item-name {
      font-size: 13px;
      font-weight: 650;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .plugin-item-sub {
      margin-top: 2px;
      color: var(--muted);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .plugin-empty {
      color: var(--muted);
      font-size: 12px;
      border: 1px dashed var(--line);
      border-radius: 7px;
      padding: 10px;
      text-align: center;
    }
    .preferences-panel {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 35;
      background: rgba(0, 0, 0, .56);
      place-items: center;
      padding: 24px;
    }
    .preferences-panel.open {
      display: grid;
    }
    .preferences-window {
      width: min(760px, 96vw);
      max-height: min(720px, 92vh);
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: 0 24px 80px rgba(0, 0, 0, .52);
      display: grid;
      grid-template-rows: 62px minmax(0, 1fr);
      overflow: hidden;
    }
    .preferences-body {
      display: grid;
      grid-template-columns: 170px minmax(0, 1fr);
      min-height: 0;
    }
    .preferences-tabs {
      border-right: 1px solid var(--line);
      background: #14181d;
      padding: 10px;
      display: grid;
      align-content: start;
      gap: 4px;
    }
    .preferences-tab {
      min-height: 34px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      text-align: left;
      padding: 0 10px;
      color: var(--muted);
    }
    .preferences-tab.active {
      color: var(--text);
      background: #25303a;
    }
    .preferences-content {
      min-width: 0;
      overflow: auto;
      padding: 16px;
      display: grid;
      gap: 16px;
      align-content: start;
    }
    .preferences-content .plugin-admin {
      border-top: 0;
      padding-top: 0;
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
          <div class="brand">DeckBridge <span style="color:#00e676;font-weight:700">BUILD relurl-1750</span></div>
          <div class="status" id="deckStatus">Loading</div>
        </div>
        <div class="header-actions">
          <button id="preferencesBtn" title="Preferences">&#9881;</button>
          <button id="refreshBtn">Refresh</button>
        </div>
        <div class="header-actions">
          <button id="undoBtn" title="Undo (Ctrl+Z)" disabled>&#8630;</button>
          <button id="redoBtn" title="Redo (Ctrl+Y)" disabled>&#8631;</button>
        </div>
      </div>
      <div class="crumb-bar">
        <button class="crumb-back" id="backBtn">Back</button>
        <div class="breadcrumb" id="breadcrumb">Page 1</div>
      </div>
      <div class="deck-wrap">
        <div class="deck" id="deck"></div>
      </div>
      <div class="page-bar">
        <div class="page-tabs" id="pageTabs"></div>
        <button class="page-add" id="addPageBtn" title="Add page">+</button>
      </div>
      <div class="device-bar">
        <span class="device-bar-label">Device</span>
        <select class="device-select" id="deviceSelect"></select>
        <span class="device-bar-label">&#9788; Brightness</span>
        <input class="brightness-slider" type="range" id="brightnessSlider" min="0" max="100" value="70" step="1">
        <span class="device-bar-value" id="brightnessValue">70%</span>
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
          <button class="secondary" id="createFolderBtn">Create Folder</button>
          <button class="primary" id="assignBtn">Assign Selected Action</button>
          <button class="secondary" id="openPiBtn">Open Property Inspector</button>
          <button class="danger" id="clearBtn">Remove Tile</button>
        </div>
      </div>
    </aside>
  </main>

  <section class="preferences-panel" id="preferencesPanel" aria-hidden="true">
    <div class="preferences-window" role="dialog" aria-modal="true" aria-labelledby="preferencesTitle">
      <div class="header">
        <div class="brand" id="preferencesTitle">Preferences</div>
        <button class="close" id="closePreferencesBtn">x</button>
      </div>
      <div class="preferences-body">
        <nav class="preferences-tabs" aria-label="Preferences">
          <button class="preferences-tab active" type="button" data-tab="plugins">Plugins</button>
        </nav>
        <div class="preferences-content">
          <div class="plugin-admin">
            <div class="plugin-admin-title">Plugins</div>
            <div class="plugin-dropzone" id="pluginDropzone">
              <div>
                <div class="plugin-drop-main">Drop plugin package</div>
                <div class="plugin-drop-sub">.streamDeckPlugin or .zip</div>
              </div>
              <button class="secondary" id="choosePluginBtn" type="button">Install from File...</button>
            </div>
            <input id="pluginFileInput" type="file" accept=".streamDeckPlugin,.zip">
            <div class="plugin-install-row">
              <input class="plugin-path" id="pluginPathInput" placeholder="/path/plugin.streamDeckPlugin" autocomplete="off">
              <button class="secondary" id="installPluginBtn">Install</button>
            </div>
            <div class="plugin-list" id="pluginList"></div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section class="pi-panel" id="piPanel">
    <div class="header">
      <div class="brand">Property Inspector</div>
      <button class="close" id="closePiBtn">x</button>
    </div>
    <iframe class="pi-frame" id="piFrame" src="about:blank"></iframe>
  </section>

  <div class="error-banner" id="errorBanner" role="alert" aria-live="assertive">
    <span id="errorBannerMsg"></span>
    <button class="error-banner-close" id="errorBannerClose" aria-label="Close">&times;</button>
  </div>

  <div class="context-menu" id="pageMenu" role="menu" aria-hidden="true">
    <button id="pageMenuInsertBtn" type="button">Insert Page After</button>
    <hr style="margin:4px 0;border-color:#3a3a3a">
    <button class="danger-command" id="pageMenuRemoveBtn" type="button">Remove Page</button>
  </div>

  <div class="context-menu" id="tileMenu" role="menu" aria-hidden="true">
    <button id="menuOpenPiBtn" type="button">Open Property Inspector</button>
    <hr style="margin:4px 0;border-color:#3a3a3a">
    <button id="menuCopyBtn" type="button">Copy</button>
    <button id="menuPasteBtn" type="button">Paste</button>
    <button id="menuDuplicateBtn" type="button">Duplicate</button>
    <button id="menuCreateFolderBtn" type="button">Create Folder</button>
    <hr style="margin:4px 0;border-color:#3a3a3a">
    <button class="danger-command" id="menuRemoveBtn" type="button">Remove Tile</button>
  </div>

  <script>
    window.DECKBRIDGE_WS_PORT = ${wsPort};
    window.DECKBRIDGE_DEBUG_PI = ${debugPI};

    var state = null;
    var ENCODER_BASE_INDEX = 1000;
    var selectedKeyIndex = null;
    var selectedContext = null;
    var selectedActionKey = null;
    var contextMenuKeyIndex = null;
    var draggingActionKey = null;
    var draggingSlot = null;
    var clipboard = null; // { pluginId, actionId, settings }
    var pointerTileDrag = null;
    var suppressTileClickUntil = 0;
    var searchValue = "";
    var liveRefreshInFlight = false;
    var piSwitchSeq = 0;
    var debugPIEnabled = Boolean(window.DECKBRIDGE_DEBUG_PI) || (new URLSearchParams(location.search).get("debugPi") === "1");
    var errorBannerTimer = null;

    function showError(msg) {
      byId("errorBannerMsg").textContent = msg || "Unknown error";
      byId("errorBanner").classList.add("visible");
      if (errorBannerTimer) clearTimeout(errorBannerTimer);
      errorBannerTimer = setTimeout(function() { clearError(); }, 7000);
    }

    function clearError() {
      byId("errorBanner").classList.remove("visible");
      if (errorBannerTimer) { clearTimeout(errorBannerTimer); errorBannerTimer = null; }
    }

    byId("errorBannerClose").addEventListener("click", clearError);

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
      if (selectedContext) {
        for (var c = 0; c < state.slots.length; c++) {
          var scoped = state.slots[c];
          if (scoped.context === selectedContext && scoped.deviceId === state.primaryDeviceId) return scoped;
        }
      }
      for (var i = 0; i < state.slots.length; i++) {
        var slot = state.slots[i];
        if (slot.keyIndex === selectedKeyIndex && slot.deviceId === state.primaryDeviceId) return slot;
      }
      return null;
    }

    function slotForKey(keyIndex) {
      if (!state) return null;
      for (var i = 0; i < state.slots.length; i++) {
        var slot = state.slots[i];
        if (slot.keyIndex === keyIndex && slot.deviceId === state.primaryDeviceId) return slot;
      }
      return null;
    }

    function currentDevice() {
      if (!state || !Array.isArray(state.devices)) return null;
      for (var i = 0; i < state.devices.length; i++) {
        if (state.devices[i].id === state.primaryDeviceId) return state.devices[i];
      }
      return null;
    }

    function isDialIndex(keyIndex) {
      return keyIndex >= ENCODER_BASE_INDEX;
    }

    function actionSupportsKey(action, keyIndex) {
      var controllers = Array.isArray(action.controllers) && action.controllers.length ? action.controllers : ["Keypad"];
      return controllers.indexOf(isDialIndex(keyIndex) ? "Encoder" : "Keypad") !== -1;
    }

    function actionAvailableOnCurrentDevice(action) {
      var controllers = Array.isArray(action.controllers) && action.controllers.length ? action.controllers : ["Keypad"];
      var device = currentDevice();
      var hasDials = !!device && Number.isInteger(device.dials) && device.dials > 0;
      if (controllers.indexOf("Keypad") !== -1) return true;
      return controllers.indexOf("Encoder") !== -1 && hasDials;
    }

    function dialIndexFromKey(keyIndex) {
      return keyIndex - ENCODER_BASE_INDEX;
    }

    function currentView() {
      return state && state.view ? state.view : { inFolder: false, navDepth: 0 };
    }

    function isFolderSlot(slot) {
      return !!slot && slot.pluginId === "com.deckbridge.system" && slot.actionId === "com.deckbridge.system.folder" && !!slot.settings && typeof slot.settings.folderId === "string";
    }

    function displayActionName(slot) {
      if (!slot) return "Empty";
      if (slot.pluginId === "com.deckbridge.system" && slot.actionId === "com.deckbridge.system.folder") return "Folder";
      if (slot.pluginId === "com.deckbridge.system" && slot.actionId === "com.deckbridge.system.nextpage") return "Next Page";
      if (slot.pluginId === "com.deckbridge.system" && slot.actionId === "com.deckbridge.system.prevpage") return "Prev Page";
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

    function debugPI(event, data) {
      if (!debugPIEnabled) return;
      var frame = byId("piFrame");
      var payload = {
        event: event,
        ts: Date.now(),
        selectedKeyIndex: selectedKeyIndex,
        frameContext: frame ? (frame.dataset.context || "") : "",
        panelOpen: byId("piPanel").classList.contains("open"),
        data: data || {}
      };
      fetch(apiUrl("/api/debug/pi"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).catch(function() {});
    }

    async function loadState() {
      var response = await fetch(apiUrl("/api/state"));
      state = await response.json();
      if (selectedKeyIndex === null) {
        selectedKeyIndex = Math.min(31, Math.max(0, state.layout.totalKeys - 1));
      }
      debugPI("loadState", { slots: state.slots.length, primaryDeviceId: state.primaryDeviceId });
      render();
    }

    async function refreshLiveState() {
      if (draggingActionKey || draggingSlot || pointerTileDrag) return;
      if (liveRefreshInFlight) return;
      liveRefreshInFlight = true;
      try {
        var imagesResponse = await fetch(apiUrl("/api/images"));
        var images = await imagesResponse.json();
        patchDeckImages(images);
        if (!byId("piPanel").classList.contains("open")) {
          var response = await fetch(apiUrl("/api/state"));
          state = await response.json();
          if (selectedKeyIndex === null) {
            selectedKeyIndex = Math.min(31, Math.max(0, state.layout.totalKeys - 1));
          }
          renderInspector();
          renderStatus();
        }
      } finally {
        liveRefreshInFlight = false;
      }
    }

    function render() {
      renderActions();
      renderDeck();
      renderInspector();
      renderStatus();
      renderPages();
      renderPlugins();
    }

    function renderPages() {
      var tabs = byId("pageTabs");
      if (!tabs || !state) return;
      var count = state.pageCount || 1;
      var active = state.activePage || 0;
      tabs.innerHTML = "";
      for (var i = 0; i < count; i++) {
        (function(idx) {
          var btn = document.createElement("button");
          btn.className = "page-tab" + (idx === active ? " active" : "");
          btn.textContent = "Page " + (idx + 1);
          btn.addEventListener("click", function() { switchPage(idx); });
          btn.addEventListener("contextmenu", function(e) { e.preventDefault(); openPageMenu(idx, e); });
          tabs.appendChild(btn);
        })(i);
      }
    }

    async function switchPage(pageIndex) {
      var res = await fetch(apiUrl("/api/pages/switch"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageIndex }),
      });
      if (res.ok) {
        state = await res.json();
        selectedKeyIndex = null;
        render();
      }
    }

    var pageMenuIndex = null;

    function openPageMenu(pageIndex, event) {
      pageMenuIndex = pageIndex;
      var menu = byId("pageMenu");
      byId("pageMenuRemoveBtn").disabled = (state.pageCount || 1) <= 1;
      menu.classList.add("open");
      menu.setAttribute("aria-hidden", "false");
      var left = event.clientX, top = event.clientY;
      if (left + menu.offsetWidth > window.innerWidth - 8) left = window.innerWidth - menu.offsetWidth - 8;
      if (top + menu.offsetHeight > window.innerHeight - 8) top = window.innerHeight - menu.offsetHeight - 8;
      menu.style.left = Math.max(8, left) + "px";
      menu.style.top = Math.max(8, top) + "px";
    }

    function closePageMenu() {
      byId("pageMenu").classList.remove("open");
      byId("pageMenu").setAttribute("aria-hidden", "true");
      pageMenuIndex = null;
    }

    async function removePage(pageIndex) {
      var res = await fetch(apiUrl("/api/pages/remove"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageIndex }),
      });
      if (res.ok) {
        state = await res.json();
        selectedKeyIndex = null;
        closePI();
        render();
      }
    }

    async function addPage(afterIndex) {
      var body = typeof afterIndex === "number" ? { afterIndex } : {};
      var res = await fetch(apiUrl("/api/pages/add"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        state = await res.json();
        var newPage = typeof afterIndex === "number" ? afterIndex + 1 : (state.pageCount || 1) - 1;
        await switchPage(newPage);
      }
    }

    function renderStatus() {
      byId("deckStatus").textContent = state.layout.columns + " x " + state.layout.rows + " / " + state.slots.length + " configured";
      byId("actionCount").textContent = state.actions.length + " available";
      renderDeviceSelect();
      var view = currentView();
      var breadcrumb = "Page " + ((state.activePage || 0) + 1);
      if (view.inFolder) breadcrumb += " / Folder" + (view.navDepth > 1 ? " " + view.navDepth : "");
      byId("breadcrumb").textContent = breadcrumb;
      byId("backBtn").style.visibility = view.inFolder ? "visible" : "hidden";
      byId("undoBtn").disabled = !state.canUndo;
      byId("redoBtn").disabled = !state.canRedo;
      var bv = typeof state.brightness === 'number' ? state.brightness : 70;
      var slider = byId("brightnessSlider");
      if (slider && !slider._dragging) { slider.value = bv; byId("brightnessValue").textContent = bv + "%"; }
    }

    function renderDeviceSelect() {
      var select = byId("deviceSelect");
      if (!select || !state) return;
      var current = select.value;
      var wanted = state.primaryDeviceId || "";
      var devices = Array.isArray(state.devices) ? state.devices : [];
      var sig = devices.map(function(d) { return d.id + ":" + d.name; }).join("|");
      if (select.dataset.sig !== sig) {
        select.textContent = "";
        devices.forEach(function(device) {
          var option = document.createElement("option");
          option.value = device.id;
          option.textContent = device.name + " (" + device.columns + "x" + device.rows + (device.dials ? ", " + device.dials + " dials" : "") + ")";
          select.appendChild(option);
        });
        select.dataset.sig = sig;
      }
      select.value = wanted || current;
    }

    function renderActions() {
      var list = byId("actionList");
      list.textContent = "";
      var groups = {};
      var filter = searchValue.trim().toLowerCase();

      state.actions.forEach(function(action) {
        if (!actionAvailableOnCurrentDevice(action)) return;
        if (selectedKeyIndex !== null && !actionSupportsKey(action, selectedKeyIndex)) return;
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
          sub.textContent = action.actionId + (Array.isArray(action.controllers) && action.controllers.indexOf("Encoder") !== -1 ? " · Encoder" : "");
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

    function renderPlugins() {
      var list = byId("pluginList");
      if (!list || !state) return;
      list.textContent = "";
      var plugins = Array.isArray(state.installedPlugins) ? state.installedPlugins : [];
      if (plugins.length === 0) {
        var empty = document.createElement("div");
        empty.className = "plugin-empty";
        empty.textContent = "No plugins installed";
        list.appendChild(empty);
        return;
      }
      plugins.forEach(function(plugin) {
        var row = document.createElement("div");
        row.className = "plugin-item";

        var meta = document.createElement("div");
        var name = document.createElement("div");
        name.className = "plugin-item-name";
        name.textContent = plugin.pluginName || plugin.pluginId;
        var sub = document.createElement("div");
        sub.className = "plugin-item-sub";
        sub.textContent = (plugin.actionCount || 0) + " actions / " + (plugin.running ? "running" : "stopped");
        meta.appendChild(name);
        meta.appendChild(sub);

        var remove = document.createElement("button");
        remove.className = "danger";
        remove.type = "button";
        remove.textContent = "Remove";
        remove.title = plugin.pluginId;
        remove.addEventListener("click", function() {
          if (!confirm("Uninstall " + (plugin.pluginName || plugin.pluginId) + "?")) return;
          uninstallPlugin(plugin.pluginId).catch(function(err) {
            showError(err.message || String(err));
          });
        });

        row.appendChild(meta);
        row.appendChild(remove);
        list.appendChild(row);
      });
    }

    function patchDeckImages(images) {
      var deck = byId("deck");
      var keys = deck.querySelectorAll("[data-key-index]");
      for (var ki = 0; ki < keys.length; ki++) {
        var key = keys[ki];
        var i = parseInt(key.dataset.keyIndex, 10);
        var entry = images.find(function(e) { return e.keyIndex === i && e.deviceId === state.primaryDeviceId; });
        if (isDialIndex(i)) {
          var newFeedbackSrc = entry ? entry.feedbackImageDataUrl : null;
          var hasFeedbackImage = typeof newFeedbackSrc === "string" && newFeedbackSrc.length > 0;
          var dialHadFeedback = key.classList.contains("has-feedback");
          if (hasFeedbackImage !== dialHadFeedback) { renderDeck(); return; }
          if (hasFeedbackImage) {
            var feedbackImg = key.querySelector("img.dial-feedback-image");
            if (!feedbackImg) { renderDeck(); return; }
            if (feedbackImg.src !== newFeedbackSrc) { feedbackImg.src = newFeedbackSrc; }
          }
          continue;
        }
        var newSrc = entry ? entry.imageDataUrl : null;
        var hasImage = typeof newSrc === "string" && newSrc.length > 0;
        var keyHadImage = key.classList.contains("has-image");
        if (hasImage !== keyHadImage) { renderDeck(); return; }
        if (hasImage) {
          var img = key.querySelector("img.key-image");
          if (!img) { renderDeck(); return; }
          if (img.src !== newSrc) { img.src = newSrc; }
        }
      }
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
        key.className = "key " + (slot ? "configured" : "empty") + (isFolderSlot(slot) ? " folder" : "") + (hasImage ? " has-image" : "") + (isMoving ? " moving" : "") + (selectedKeyIndex === i ? " selected" : "");
        key.title = slot ? slot.actionId : "Empty";
        key.dataset.keyIndex = String(i);
        key.draggable = false;

        if (hasImage) {
          var image = document.createElement("img");
          image.className = "key-image";
          image.src = slot.imageDataUrl;
          image.alt = displayActionName(slot);
          key.appendChild(image);
        } else if (slot && !slot.isSystem) {
          var actionDef = state.actions.find(function(a) { return a.actionId === slot.actionId; });
          var stateIndex = Number.isInteger(slot.state) ? slot.state : 0;
          var stateImage = actionDef && Array.isArray(actionDef.stateImages) ? actionDef.stateImages[stateIndex] : null;
          if (actionDef && stateImage) {
            var stateImg = document.createElement("img");
            stateImg.className = "key-image";
            stateImg.src = "/" + actionDef.pluginId + "/" + stateImage + ".png";
            stateImg.alt = displayActionName(slot);
            key.appendChild(stateImg);
          }
        } else {
          var emptyLabel = document.createElement("div");
          emptyLabel.className = "key-label";
          emptyLabel.textContent = (draggingActionKey || draggingSlot) ? "+" : "Empty";
          key.appendChild(emptyLabel);
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

      var device = currentDevice();
      var dialCount = device && Number.isInteger(device.dials) ? device.dials : 0;
      if (dialCount > 0) {
        var strip = document.createElement("div");
        strip.className = "dial-strip";
        for (var d = 0; d < dialCount; d++) {
          var keyIndex = ENCODER_BASE_INDEX + d;
          var slot = slotForKey(keyIndex);
          var isMoving = draggingSlot && slot && draggingSlot.deviceId === slot.deviceId && draggingSlot.keyIndex === keyIndex;
          var hasFeedbackImage = slot && slot.feedback && typeof slot.feedback.imageDataUrl === "string" && slot.feedback.imageDataUrl.length > 0;
          var dial = document.createElement("div");
          dial.className = "key dial " + (slot ? "configured" : "empty") + (hasFeedbackImage ? " has-feedback" : "") + (isMoving ? " moving" : "") + (selectedKeyIndex === keyIndex ? " selected" : "");
          dial.title = slot ? slot.actionId : "Empty dial";
          dial.dataset.keyIndex = String(keyIndex);
          dial.tabIndex = 0;
          dial.setAttribute("role", "button");

          var num = document.createElement("div");
          num.className = "key-num";
          num.textContent = "Dial " + (d + 1);
          dial.appendChild(num);

          var label = document.createElement("div");
          label.className = "key-label";
          if (hasFeedbackImage) {
            var feedbackImage = document.createElement("img");
            feedbackImage.src = slot.feedback.imageDataUrl;
            feedbackImage.alt = displayActionName(slot);
            feedbackImage.className = "dial-feedback-image";
            label.appendChild(feedbackImage);
          } else {
            label.textContent = slot
              ? (slot.feedback && (slot.feedback.title || slot.feedback.value)
                ? [slot.feedback.title, slot.feedback.value].filter(Boolean).join(" ")
                : displayActionName(slot))
              : ((draggingActionKey || draggingSlot) ? "+" : "Empty");
          }
          dial.appendChild(label);

          var controls = document.createElement("div");
          controls.className = "dial-controls";
          controls.addEventListener("pointerdown", function(event) {
            event.stopPropagation();
          });
          controls.addEventListener("pointerup", function(event) {
            event.stopPropagation();
          });
          controls.addEventListener("pointercancel", function(event) {
            event.stopPropagation();
          });
          var dec = document.createElement("button");
          dec.type = "button";
          dec.textContent = "-";
          dec.title = "Rotate left";
          dec.addEventListener("click", function(idx, event) {
            event.preventDefault();
            event.stopPropagation();
            sendDialRotate(idx, -1).catch(function(err) { showError(err.message || String(err)); });
          }.bind(null, d));
          var press = document.createElement("button");
          press.type = "button";
          press.className = "dial-press";
          press.textContent = "Press";
          press.title = "Press dial";
          press.addEventListener("click", function(idx, event) {
            event.preventDefault();
            event.stopPropagation();
            sendDialPress(idx).catch(function(err) { showError(err.message || String(err)); });
          }.bind(null, d));
          var touch = document.createElement("button");
          touch.type = "button";
          touch.textContent = "Touch";
          touch.title = "Touch dial screen";
          touch.addEventListener("click", function(idx, event) {
            event.preventDefault();
            event.stopPropagation();
            sendDialTouch(idx).catch(function(err) { showError(err.message || String(err)); });
          }.bind(null, d));
          var inc = document.createElement("button");
          inc.type = "button";
          inc.textContent = "+";
          inc.title = "Rotate right";
          inc.addEventListener("click", function(idx, event) {
            event.preventDefault();
            event.stopPropagation();
            sendDialRotate(idx, 1).catch(function(err) { showError(err.message || String(err)); });
          }.bind(null, d));
          controls.appendChild(dec);
          controls.appendChild(press);
          controls.appendChild(touch);
          controls.appendChild(inc);
          dial.appendChild(controls);

          dial.addEventListener("click", activateKey.bind(null, keyIndex));
          dial.addEventListener("contextmenu", openTileMenu.bind(null, keyIndex));
          dial.addEventListener("pointerdown", handleTilePointerDown.bind(null, keyIndex));
          dial.addEventListener("pointermove", handleTilePointerMove);
          dial.addEventListener("pointerup", handleTilePointerUp);
          dial.addEventListener("pointercancel", cancelTilePointerDrag);
          dial.addEventListener("dragover", function(event) {
            event.preventDefault();
            closeTileMenu();
            event.currentTarget.classList.add("drag-over");
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
          });
          dial.addEventListener("dragleave", function(event) {
            event.currentTarget.classList.remove("drag-over");
          });
          dial.addEventListener("drop", handleDrop.bind(null, keyIndex));
          strip.appendChild(dial);
        }
        deck.appendChild(strip);
      }
    }

    function renderInspector() {
      var slot = selectedSlot();
      selectedContext = slot ? (slot.context || null) : null;
      var action = slot ? findAction(slot.pluginId, slot.actionId) : null;
      var isFolder = isFolderSlot(slot);
      byId("selectedKeyLabel").textContent = selectedKeyIndex === null
        ? ""
        : (isDialIndex(selectedKeyIndex) ? "Dial " + (dialIndexFromKey(selectedKeyIndex) + 1) : "Key " + selectedKeyIndex);
      byId("tileAction").textContent = slot ? displayActionName(slot) : "Empty";
      byId("tilePlugin").textContent = slot ? displayPluginName(slot) : "-";
      byId("tileContext").textContent = slot ? slot.context : "-";
      byId("assignBtn").disabled = selectedKeyIndex === null || selectedActionKey === null || (!!slot?.isSystem && !isFolder);
      byId("clearBtn").disabled = !slot || (!!slot.isSystem && !isFolder);
      byId("openPiBtn").disabled = !slot || (!isFolder && (!!slot.isSystem || !slot.piUrl));
      byId("createFolderBtn").disabled = selectedKeyIndex === null || !!slot?.isSystem;
      if (action && !selectedActionKey) selectedActionKey = actionKey(action);

      if (byId("piPanel").classList.contains("open")) {
        var expectedContext = "";
        if (slot) {
          if (isFolder) expectedContext = "folder:" + slot.deviceId + "|" + String(slot.keyIndex);
          else if (slot.piUrl) expectedContext = slot.context || "";
        }
        var currentContext = ensurePIFrame().dataset.context || "";
        if (!expectedContext) {
          debugPI("renderInspector:close-no-expected", { currentContext: currentContext });
          closePI();
        }
        else if (expectedContext !== currentContext) {
          debugPI("renderInspector:reopen-context-mismatch", {
            expectedContext: expectedContext,
            currentContext: currentContext,
          });
          openSelectedPI();
        }
      }
    }

    function selectKey(keyIndex) {
      selectedKeyIndex = keyIndex;
      render();
    }

    function activateKey(keyIndex) {
      if (Date.now() < suppressTileClickUntil) return;
      var prev = selectedKeyIndex;
      var clickedSlot = slotForKey(keyIndex);
      selectedKeyIndex = keyIndex;
      selectedContext = clickedSlot ? (clickedSlot.context || null) : null;
      closeTileMenu();
      if (prev !== keyIndex) closePI();
      render();
      var slot = clickedSlot || slotForKey(keyIndex);
      debugPI("activateKey", {
        prevKeyIndex: prev,
        keyIndex: keyIndex,
        hasSlot: !!slot,
        slotAction: slot ? slot.actionId : null,
        slotContext: slot ? slot.context : null,
        isSystem: slot ? !!slot.isSystem : null,
      });
      if (isFolderSlot(slot)) {
        if (prev === keyIndex) {
          enterFolder(slot.settings.folderId);
        } else {
          openSelectedPI();
        }
        return;
      }
      if (slot && !slot.isSystem && slot.piUrl) {
        openSelectedPI();
      } else {
        closePI();
      }
    }

    async function createFolderAt(keyIndex) {
      if (keyIndex === null || keyIndex === undefined) return;
      var response = await fetch(apiUrl("/api/folders/create"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: state.primaryDeviceId, keyIndex: keyIndex }),
      });
      if (!response.ok) {
        var message = await response.text();
        throw new Error(message || "Create folder failed");
      }
      state = await response.json();
      selectedKeyIndex = keyIndex;
      render();
    }

    async function enterFolder(folderId) {
      if (!folderId) return;
      var response = await fetch(apiUrl("/api/folders/enter"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId: folderId }),
      });
      if (!response.ok) {
        var message = await response.text();
        throw new Error(message || "Open folder failed");
      }
      state = await response.json();
      selectedKeyIndex = null;
      closePI();
      render();
    }

    async function exitFolder() {
      var response = await fetch(apiUrl("/api/folders/exit"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        var message = await response.text();
        throw new Error(message || "Exit folder failed");
      }
      state = await response.json();
      selectedKeyIndex = null;
      closePI();
      render();
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
          showError(err instanceof Error ? err.message : String(err));
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
      if (!actionSupportsKey(action, targetKeyIndex)) {
        throw new Error("Action does not support " + (isDialIndex(targetKeyIndex) ? "Encoder" : "Keypad"));
      }
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

    async function selectDevice(deviceId) {
      if (!deviceId || !state || deviceId === state.primaryDeviceId) return;
      var response = await fetch(apiUrl("/api/device/select"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: deviceId })
      });
      if (!response.ok) {
        var message = await response.text();
        throw new Error(message || "Device select failed");
      }
      state = await response.json();
      selectedKeyIndex = null;
      selectedContext = null;
      closePI();
      render();
    }

    async function sendDialRotate(dialIndex, ticks) {
      var response = await fetch(apiUrl("/api/dials/rotate"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: state.primaryDeviceId, dialIndex: dialIndex, ticks: ticks })
      });
      if (!response.ok) {
        var message = await response.text();
        throw new Error(message || "Dial rotate failed");
      }
    }

    async function sendDialPress(dialIndex) {
      var response = await fetch(apiUrl("/api/dials/press"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: state.primaryDeviceId, dialIndex: dialIndex })
      });
      if (!response.ok) {
        var message = await response.text();
        throw new Error(message || "Dial press failed");
      }
    }

    async function sendDialTouch(dialIndex) {
      var response = await fetch(apiUrl("/api/dials/touch"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: state.primaryDeviceId, dialIndex: dialIndex, hold: false, tapPos: [dialIndex * 200 + 100, 50] })
      });
      if (!response.ok) {
        var message = await response.text();
        throw new Error(message || "Dial touch failed");
      }
    }

    async function installPlugin() {
      var input = byId("pluginPathInput");
      var sourcePath = input.value.trim();
      if (!sourcePath) return;
      setPluginInstallBusy(true);
      try {
        var response = await fetch(apiUrl("/api/plugins/install"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: sourcePath })
        });
        if (!response.ok) {
          var message = await response.text();
          throw new Error(message || "Plugin install failed");
        }
        state = await response.json();
        input.value = "";
        render();
      } finally {
        setPluginInstallBusy(false);
      }
    }

    function setPluginInstallBusy(busy) {
      byId("installPluginBtn").disabled = busy;
      byId("choosePluginBtn").disabled = busy;
      byId("pluginDropzone").classList.toggle("busy", busy);
      byId("pluginDropzone").querySelector(".plugin-drop-main").textContent = busy ? "Installing..." : "Drop plugin package";
    }

    async function uploadPluginFile(file) {
      if (!file) return;
      if (!file.name.endsWith(".streamDeckPlugin") && !file.name.endsWith(".zip")) {
        throw new Error("Expected .streamDeckPlugin or .zip file");
      }
      setPluginInstallBusy(true);
      var url = apiUrl("/api/plugins/upload");
      url.searchParams.set("filename", file.name);
      try {
        var response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: file
        });
        if (!response.ok) {
          var message = await response.text();
          throw new Error(message || "Plugin upload failed");
        }
        state = await response.json();
        render();
      } finally {
        setPluginInstallBusy(false);
        byId("pluginFileInput").value = "";
      }
    }

    async function uninstallPlugin(pluginId) {
      if (!pluginId) return;
      var response = await fetch(apiUrl("/api/plugins/uninstall"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pluginId: pluginId })
      });
      if (!response.ok) {
        var message = await response.text();
        throw new Error(message || "Plugin remove failed");
      }
      state = await response.json();
      if (selectedSlot() && selectedSlot().pluginId === pluginId) {
        selectedKeyIndex = null;
        selectedContext = null;
        closePI();
      }
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
          showError(err instanceof Error ? err.message : String(err));
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
          showError(err instanceof Error ? err.message : String(err));
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
      byId("menuOpenPiBtn").disabled = (!slot.piUrl && !isFolderSlot(slot));
      byId("menuCopyBtn").disabled = !!slot.isSystem;
      byId("menuPasteBtn").disabled = !clipboard || !!slot.isSystem;
      byId("menuDuplicateBtn").disabled = !!slot.isSystem;
      byId("menuCreateFolderBtn").disabled = !!slot.isSystem;
      byId("menuRemoveBtn").disabled = !!slot.isSystem;

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
      var slot = slotForKey(contextMenuKeyIndex);
      selectedContext = slot ? (slot.context || null) : null;
      closeTileMenu();
      renderInspector();
      openSelectedPI();
    }

    function copyContextMenuTile() {
      if (contextMenuKeyIndex === null) return;
      var slot = slotForKey(contextMenuKeyIndex);
      if (!slot) return;
      clipboard = { pluginId: slot.pluginId, actionId: slot.actionId, settings: slot.settings || {} };
      closeTileMenu();
    }

    async function pasteContextMenuTile() {
      if (contextMenuKeyIndex === null || !clipboard) return;
      var keyIndex = contextMenuKeyIndex;
      closeTileMenu();
      var deviceId = state && state.primaryDeviceId;
      if (!deviceId) return;
      var res = await fetch("/api/slots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, keyIndex, pluginId: clipboard.pluginId, actionId: clipboard.actionId, settings: clipboard.settings }),
      });
      if (res.ok) await loadState();
    }

    async function duplicateContextMenuTile() {
      if (contextMenuKeyIndex === null) return;
      var slot = slotForKey(contextMenuKeyIndex);
      if (!slot) return;
      clipboard = { pluginId: slot.pluginId, actionId: slot.actionId, settings: slot.settings || {} };
      closeTileMenu();
      // Find first empty key
      var layout = state && state.layout;
      var total = layout ? layout.columns * layout.rows : 32;
      for (var i = 0; i < total; i++) {
        if (!slotForKey(i)) {
          var deviceId = state && state.primaryDeviceId;
          if (!deviceId) return;
          var res = await fetch("/api/slots", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceId, keyIndex: i, pluginId: clipboard.pluginId, actionId: clipboard.actionId, settings: clipboard.settings }),
          });
          if (res.ok) {
            await loadState();
            selectedKeyIndex = i;
            renderDeck();
          }
          return;
        }
      }
    }

    async function createFolderContextMenuTile() {
      if (contextMenuKeyIndex === null) return;
      var keyIndex = contextMenuKeyIndex;
      closeTileMenu();
      try {
        await createFolderAt(keyIndex);
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
      }
    }

    function ensurePIFrame() {
      var frame = byId("piFrame");
      if (frame) return frame;
      var created = document.createElement("iframe");
      created.className = "pi-frame";
      created.id = "piFrame";
      created.src = "about:blank";
      byId("piPanel").appendChild(created);
      return created;
    }

    function replacePIFrame() {
      var oldFrame = ensurePIFrame();
      var fresh = document.createElement("iframe");
      fresh.className = oldFrame.className || "pi-frame";
      fresh.id = "piFrame";
      fresh.src = "about:blank";
      oldFrame.replaceWith(fresh);
      return fresh;
    }

    function setPIFrame(url, context) {
      var panel = byId("piPanel");
      piSwitchSeq += 1;
      var seq = piSwitchSeq;
      var frame = replacePIFrame();
      frame.dataset.context = context || "";
      debugPI("setPIFrame:start", { seq: seq, context: context, url: url });
      if (seq !== piSwitchSeq) return;
      frame.src = url;
      panel.classList.add("open");
      debugPI("setPIFrame:apply", { seq: seq, context: context, url: url });
    }

    function openSelectedPI() {
      var slot = selectedSlot();
      if (!slot) {
        debugPI("openSelectedPI:no-slot", {});
        closePI();
        return;
      }
      debugPI("openSelectedPI", {
        keyIndex: slot.keyIndex,
        deviceId: slot.deviceId,
        actionId: slot.actionId,
        context: slot.context,
        isFolder: isFolderSlot(slot),
      });
      if (isFolderSlot(slot)) {
        var params = new URLSearchParams({
          deviceId: slot.deviceId,
          keyIndex: String(slot.keyIndex),
          folderName: (slot.settings && typeof slot.settings.folderName === "string") ? slot.settings.folderName : "Folder",
          folderColor: (slot.settings && typeof slot.settings.folderColor === "string") ? slot.settings.folderColor : "#7f8694",
          _piTs: String(Date.now()),
        });
        setPIFrame("/system/folder-editor?" + params.toString(), "folder:" + slot.deviceId + "|" + String(slot.keyIndex));
      } else {
        if (!slot.piUrl) {
          debugPI("openSelectedPI:no-pi-url", { keyIndex: slot.keyIndex, actionId: slot.actionId });
          closePI();
          return;
        }
        var targetUrl = slot.piUrl;
        try {
          var parsed = new URL(targetUrl, location.origin);
          parsed.searchParams.set("_piTs", String(Date.now()));
          targetUrl = parsed.toString();
        } catch (err) {
          // ignore parse failure and keep original URL
        }
        setPIFrame(targetUrl, slot.context || "");
      }
    }

    function closePI() {
      piSwitchSeq += 1;
      var frame = replacePIFrame();
      frame.dataset.context = "";
      byId("piPanel").classList.remove("open");
      debugPI("closePI", { seq: piSwitchSeq });
    }

    function openPreferences() {
      byId("preferencesPanel").classList.add("open");
      byId("preferencesPanel").setAttribute("aria-hidden", "false");
      renderPlugins();
    }

    function closePreferences() {
      byId("preferencesPanel").classList.remove("open");
      byId("preferencesPanel").setAttribute("aria-hidden", "true");
    }

    byId("actionSearch").addEventListener("input", function(event) {
      searchValue = event.target.value;
      renderActions();
    });
    byId("addPageBtn").addEventListener("click", function() { addPage(state ? state.activePage : undefined); });
    byId("deviceSelect").addEventListener("change", function(event) {
      selectDevice(event.target.value).catch(function(err) {
        showError(err.message || String(err));
      });
    });
    byId("backBtn").addEventListener("click", function() {
      exitFolder().catch(function(err) {
        showError(err.message || String(err));
      });
    });
    byId("refreshBtn").addEventListener("click", loadState);
        byId("undoBtn").addEventListener("click", async function() {
          var res = await fetch(apiUrl("/api/profile/undo"), { method: "POST" });
          var data = await res.json();
          state.canUndo = data.canUndo; state.canRedo = data.canRedo;
          renderStatus();
          await loadState();
        });
        byId("redoBtn").addEventListener("click", async function() {
          var res = await fetch(apiUrl("/api/profile/redo"), { method: "POST" });
          var data = await res.json();
          state.canUndo = data.canUndo; state.canRedo = data.canRedo;
          renderStatus();
          await loadState();
        });
        (function() {
          var slider = byId("brightnessSlider");
          var label = byId("brightnessValue");
          var bTimer = null;
          slider.addEventListener("mousedown", function() { slider._dragging = true; });
          slider.addEventListener("mouseup",   function() { slider._dragging = false; });
          slider.addEventListener("touchstart", function() { slider._dragging = true; }, { passive: true });
          slider.addEventListener("touchend",   function() { slider._dragging = false; });
          slider.addEventListener("input", function() {
            var v = parseInt(slider.value, 10);
            label.textContent = v + "%";
            clearTimeout(bTimer);
            bTimer = setTimeout(async function() {
              try {
                await fetch(apiUrl("/api/device/brightness"), {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ value: v })
                });
                state.brightness = v;
              } catch(e) { showError("Brightness error: " + e.message); }
            }, 150);
          });
        })();
    byId("createFolderBtn").addEventListener("click", function() {
      createFolderAt(selectedKeyIndex).catch(function(err) {
        showError(err.message || String(err));
      });
    });
    byId("assignBtn").addEventListener("click", assignSelectedAction);
    byId("clearBtn").addEventListener("click", clearSelectedTile);
    byId("openPiBtn").addEventListener("click", openSelectedPI);
    byId("preferencesBtn").addEventListener("click", openPreferences);
    byId("closePreferencesBtn").addEventListener("click", closePreferences);
    byId("preferencesPanel").addEventListener("click", function(event) {
      if (event.target === event.currentTarget) closePreferences();
    });
    byId("installPluginBtn").addEventListener("click", function() {
      installPlugin().catch(function(err) {
        showError(err.message || String(err));
      });
    });
    byId("choosePluginBtn").addEventListener("click", function() {
      byId("pluginFileInput").click();
    });
    byId("pluginFileInput").addEventListener("change", function(event) {
      var file = event.target.files && event.target.files[0];
      uploadPluginFile(file).catch(function(err) {
        showError(err.message || String(err));
      });
    });
    byId("pluginDropzone").addEventListener("dragover", function(event) {
      event.preventDefault();
      event.currentTarget.classList.add("drag-over");
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
    byId("pluginDropzone").addEventListener("dragleave", function(event) {
      event.currentTarget.classList.remove("drag-over");
    });
    byId("pluginDropzone").addEventListener("drop", function(event) {
      event.preventDefault();
      event.currentTarget.classList.remove("drag-over");
      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      uploadPluginFile(file).catch(function(err) {
        showError(err.message || String(err));
      });
    });
    byId("pluginPathInput").addEventListener("keydown", function(event) {
      if (event.key !== "Enter") return;
      event.preventDefault();
      installPlugin().catch(function(err) {
        showError(err.message || String(err));
      });
    });
    byId("closePiBtn").addEventListener("click", closePI);
    byId("menuOpenPiBtn").addEventListener("click", openContextMenuPI);
    byId("menuCopyBtn").addEventListener("click", copyContextMenuTile);
    byId("menuPasteBtn").addEventListener("click", pasteContextMenuTile);
    byId("menuDuplicateBtn").addEventListener("click", duplicateContextMenuTile);
    byId("menuCreateFolderBtn").addEventListener("click", createFolderContextMenuTile);
    byId("menuRemoveBtn").addEventListener("click", removeContextMenuTile);
    byId("tileMenu").addEventListener("click", function(event) { event.stopPropagation(); });
    byId("pageMenu").addEventListener("click", function(event) { event.stopPropagation(); });
    byId("pageMenuInsertBtn").addEventListener("click", function() {
      var idx = pageMenuIndex;
      closePageMenu();
      if (idx !== null) addPage(idx);
    });
    byId("pageMenuRemoveBtn").addEventListener("click", function() {
      var idx = pageMenuIndex;
      closePageMenu();
      if (idx !== null) removePage(idx);
    });
    document.addEventListener("click", function() { closeTileMenu(); closePageMenu(); });
    window.addEventListener("resize", function() { closeTileMenu(); closePageMenu(); });
    window.addEventListener("scroll", closeTileMenu, true);
    window.addEventListener("keydown", function(event) {
      if (event.key === "Escape" && byId("preferencesPanel").classList.contains("open")) {
        closePreferences();
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedSlot()) {
        clearSelectedTile();
      }
      if ((event.key === "z" || event.key === "Z") && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
        event.preventDefault();
        byId("undoBtn").click();
      }
      if (((event.key === "z" || event.key === "Z") && (event.ctrlKey || event.metaKey) && event.shiftKey) ||
          ((event.key === "y" || event.key === "Y") && (event.ctrlKey || event.metaKey))) {
        event.preventDefault();
        byId("redoBtn").click();
      }
      if (event.key === "Escape") {
        if (currentView().inFolder && byId("piPanel").classList.contains("open") === false) {
          exitFolder().catch(function(err) {
            showError(err.message || String(err));
          });
          return;
        }
        closeTileMenu();
        closePI();
      }
    });

    loadState().catch(function(err) {
      showError(err.message || String(err));
    });
    window.setInterval(function() {
      refreshLiveState().catch(function(err) {
        showError(err.message || String(err));
      });
    }, 1000);
  </script>
</body>
</html>`

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  }
}
