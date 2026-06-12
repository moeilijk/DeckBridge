import { readdir, readFile, writeFile, mkdir, appendFile, cp, rm, mkdtemp, rename, stat, access } from 'fs/promises'
import { constants, existsSync } from 'fs'
import { basename, join, resolve } from 'path'
import { homedir, tmpdir } from 'os'
import { spawn, execFile, ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

interface ManifestAction {
  UUID: string
  Name?: string
  Tooltip?: string
  Icon?: string
  PropertyInspectorPath?: string
  States?: { Image?: string }[]
  Controllers?: string[]
  Encoder?: {
    layout?: string
    TriggerDescription?: Record<string, string>
  }
}

interface Manifest {
  UUID?: string
  Name?: string
  Version: string
  SDKVersion?: number
  Nodejs?: { Version: string }
  CodePath?: string
  CodePathLinux?: string
  CodePathMac?: string
  CodePathWin?: string
  PropertyInspectorPath?: string  // globale fallback PI
  ApplicationsToMonitor?: string[] | { linux?: string[]; mac?: string[]; windows?: string[] }
  Actions?: ManifestAction[]
}

export interface PluginActionInfo {
  pluginId: string
  pluginName: string
  actionId: string
  name: string
  tooltip: string
  icon?: string
  stateImages: string[]
  piFile: string
  controllers: Array<'Keypad' | 'Encoder'>
  encoder?: {
    layout?: string
    triggerDescription?: Record<string, string>
  }
}

// Publieke plugin metadata die andere componenten kunnen opvragen
export interface PluginInfo {
  pluginId: string       // manifest UUID
  pluginName: string
  pluginDir: string
  defaultPiPath: string  // fallback PropertyInspectorPath
  actions: Map<string, PluginActionInfo>  // actionId -> action metadata
  applicationsToMonitor: string[]
}

export interface InstalledPluginInfo {
  pluginId: string
  pluginName: string
  pluginDir: string
  actionCount: number
  running: boolean
}

interface PluginInstance {
  uuid: string
  pluginUUID: string
  process: ChildProcess
  pluginDir: string
}

export class PluginManager {
  private instances = new Map<string, PluginInstance>()
  private pluginInfo = new Map<string, PluginInfo>()   // pluginId → info
  private globalSettings = new Map<string, Record<string, unknown>>()
  private settingsDir = join(homedir(), '.config', 'DeckBridge', 'settings')
  private logsDir = join(homedir(), '.config', 'DeckBridge', 'logs', 'plugins')
  private runtimeWsPort = 0
  private runtimeDeviceInfo: object | object[] = []

  private parseApplicationsToMonitor(value: Manifest['ApplicationsToMonitor']): string[] {
    if (!value) return []
    const normalize = (items: string[]): string[] => items
      .map((v) => v.trim())
      .filter(Boolean)

    if (Array.isArray(value)) return normalize(value)
    return normalize(value.linux ?? value.mac ?? value.windows ?? [])
  }

  private parseControllers(value: string[] | undefined): Array<'Keypad' | 'Encoder'> {
    if (!Array.isArray(value) || value.length === 0) return ['Keypad']
    const controllers = value
      .map((controller) => controller === 'Encoder' || controller === 'Keypad' ? controller : '')
      .filter((controller): controller is 'Keypad' | 'Encoder' => controller === 'Keypad' || controller === 'Encoder')
    return controllers.length > 0 ? Array.from(new Set(controllers)) : ['Keypad']
  }

  async loadPlugins(pluginDir: string, wsPort: number, deviceInfo: object | object[]): Promise<void> {
    this.runtimeWsPort = wsPort
    this.runtimeDeviceInfo = deviceInfo
    await mkdir(pluginDir, { recursive: true })
    if (!existsSync(pluginDir)) {
      console.warn(`Plugin directory niet gevonden: ${pluginDir}`)
      return
    }

    const entries = await readdir(pluginDir, { withFileTypes: true })
    const pluginDirs = entries.filter(e => (e.isDirectory() || e.isSymbolicLink()) && e.name.endsWith('.sdPlugin'))

    for (const entry of pluginDirs) {
      const dir = join(pluginDir, entry.name)
      await this.loadPlugin(dir, wsPort, deviceInfo)
    }
  }

  async loadInstalledPlugin(pluginDir: string, wsPort = this.runtimeWsPort, deviceInfo = this.runtimeDeviceInfo): Promise<void> {
    await this.loadPlugin(pluginDir, wsPort, deviceInfo)
  }

  private async loadPlugin(pluginDir: string, wsPort: number, deviceInfo: object | object[]): Promise<void> {
    const manifestPath = join(pluginDir, 'manifest.json')
    if (!existsSync(manifestPath)) return

    let manifest: Manifest
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch {
      console.error(`Kon manifest niet lezen: ${manifestPath}`)
      return
    }

    // Some older plugin bundles omit top-level UUID; fall back to folder name.
    const pluginId = (typeof manifest.UUID === 'string' && manifest.UUID.length > 0)
      ? manifest.UUID
      : basename(pluginDir, '.sdPlugin')
    if (!manifest.UUID) {
      console.warn(`Manifest UUID ontbreekt, fallback naar mapnaam: ${pluginId}`)
    }

    // Sla PI-paden op per actie zodat de host de juiste PI kan openen
    const actionMap = new Map<string, PluginActionInfo>()
    for (const action of manifest.Actions ?? []) {
      const piPath = action.PropertyInspectorPath ?? manifest.PropertyInspectorPath ?? ''
      const pluginName = manifest.Name ?? pluginId
      actionMap.set(action.UUID, {
        pluginId,
        pluginName,
        actionId: action.UUID,
        name: action.Name ?? action.UUID,
        tooltip: action.Tooltip ?? '',
        icon: action.Icon,
        stateImages: (action.States ?? [])
          .map((state) => state.Image)
          .filter((image): image is string => typeof image === 'string' && image.length > 0),
        piFile: piPath,
        controllers: this.parseControllers(action.Controllers),
        encoder: action.Encoder
          ? {
              layout: typeof action.Encoder.layout === 'string' ? action.Encoder.layout : undefined,
              triggerDescription: action.Encoder.TriggerDescription,
            }
          : undefined,
      })
    }
    this.pluginInfo.set(pluginId, {
      pluginId,
      pluginName: manifest.Name ?? pluginId,
      pluginDir,
      defaultPiPath: manifest.PropertyInspectorPath ?? '',
      actions: actionMap,
      applicationsToMonitor: this.parseApplicationsToMonitor(manifest.ApplicationsToMonitor),
    })

    const pluginUUID = randomUUID()
    const infoJson = JSON.stringify({
      application: { language: 'en', platform: 'mac', platformVersion: '14.0', version: '7.3.0' },
      devicePixelRatio: 1,
      devices: Array.isArray(deviceInfo) ? deviceInfo : [deviceInfo],
      plugin: { uuid: pluginId, version: manifest.Version },
    })

    const args = ['-port', String(wsPort), '-pluginUUID', pluginUUID, '-registerEvent', 'registerPlugin', '-info', infoJson]

    if (manifest.Nodejs) {
      const codePath = manifest.CodePathMac ?? manifest.CodePath
      if (!codePath) return

      const entryPoint = join(pluginDir, codePath)
      if (!existsSync(entryPoint)) {
        console.error(`Plugin entry point niet gevonden: ${entryPoint}`)
        return
      }

        this.spawnPlugin(pluginId, pluginUUID, pluginDir, 'node', [entryPoint, ...args])
    } else {
      // Prefer a native Linux binary when CodePathLinux is declared and present.
      const linuxBin = manifest.CodePathLinux
      if (linuxBin) {
        const binPath = join(pluginDir, linuxBin)
        if (existsSync(binPath)) {
          try {
            await access(binPath, constants.X_OK)
            this.spawnPlugin(pluginId, pluginUUID, pluginDir, binPath, args)
            return
          } catch {
            console.warn(`Plugin Linux binary is niet uitvoerbaar, fallback naar Wine/CodePath: ${binPath}`)
          }
        }
      }

      const codePath = manifest.CodePathWin ?? manifest.CodePath
      if (!codePath) return

      const exePath = join(pluginDir, codePath)
      if (!existsSync(exePath)) {
        console.error(`Plugin binary niet gevonden: ${exePath}`)
        return
      }

      const winePrefix = join(homedir(), '.config', 'DeckBridge', 'wine', pluginId)
      await mkdir(winePrefix, { recursive: true })

      this.spawnPlugin(pluginId, pluginUUID, pluginDir, 'wine', [exePath, ...args], {
        WINEPREFIX: winePrefix,
        WINEDEBUG: '-all',
      })
    }
  }

  private spawnPlugin(
    uuid: string,
    pluginUUID: string,
    pluginDir: string,
    cmd: string,
    args: string[],
    extraEnv: Record<string, string> = {},
  ): void {
    this.stopPluginById(uuid)
    const proc = spawn(cmd, args, {
      cwd: pluginDir,
      stdio: 'pipe',
      env: { ...process.env, ...extraEnv },
    })

    proc.stdout?.on('data', (d) => process.stdout.write(`[${uuid}] ${d}`))
    proc.stderr?.on('data', (d) => process.stderr.write(`[${uuid}] ${d}`))
    proc.on('error', (err) => {
      console.error(`Plugin startfout: ${uuid}: ${err.message}`)
      this.instances.delete(pluginUUID)
    })
    proc.on('exit', (code) => {
      console.log(`Plugin gestopt: ${uuid} (exit ${code})`)
      this.instances.delete(pluginUUID)
    })

    this.instances.set(pluginUUID, { uuid, pluginUUID, process: proc, pluginDir })
    console.log(`Plugin gestart: ${uuid} via ${cmd}`)
  }

  getPluginInfo(pluginId: string): PluginInfo | undefined {
    return this.pluginInfo.get(pluginId)
  }

  getInstalledPlugins(): InstalledPluginInfo[] {
    return Array.from(this.pluginInfo.values())
      .map((info) => ({
        pluginId: info.pluginId,
        pluginName: info.pluginName,
        pluginDir: info.pluginDir,
        actionCount: info.actions.size,
        running: Array.from(this.instances.values()).some((instance) => instance.uuid === info.pluginId),
      }))
      .sort((a, b) => a.pluginName.localeCompare(b.pluginName))
  }

  async installPlugin(sourcePath: string, pluginBaseDir: string, wsPort = this.runtimeWsPort, deviceInfo = this.runtimeDeviceInfo): Promise<InstalledPluginInfo> {
    const source = resolve(sourcePath)
    const sourceStat = await stat(source)
    const tempRoot = await mkdtemp(join(tmpdir(), 'deckbridge-plugin-'))
    let pluginRoot = source

    try {
      if (sourceStat.isFile()) {
        if (!source.endsWith('.streamDeckPlugin') && !source.endsWith('.zip')) {
          throw new Error('Expected .streamDeckPlugin or .zip file')
        }
        try {
          await execFileAsync('unzip', ['-q', source, '-d', tempRoot])
        } catch {
          throw new Error('Plugin package is not a valid .streamDeckPlugin or .zip file')
        }
        pluginRoot = await this.findPluginRoot(tempRoot)
      } else if (!sourceStat.isDirectory()) {
        throw new Error('Source is not a file or directory')
      }

      if (!pluginRoot.endsWith('.sdPlugin')) {
        const manifest = await this.readManifest(pluginRoot)
        pluginRoot = await this.copyToNamedPluginDir(pluginRoot, tempRoot, `${this.safePluginDirName(manifest.UUID ?? basename(pluginRoot))}.sdPlugin`)
      }

      const manifest = await this.readManifest(pluginRoot)
      const pluginId = typeof manifest.UUID === 'string' && manifest.UUID.length > 0
        ? manifest.UUID
        : basename(pluginRoot, '.sdPlugin')
      const targetName = `${this.safePluginDirName(pluginId)}.sdPlugin`
      const targetPath = join(pluginBaseDir, targetName)
      const stagingPath = join(pluginBaseDir, `${targetName}.installing-${Date.now()}`)

      await mkdir(pluginBaseDir, { recursive: true })
      this.stopPluginById(pluginId)
      if (resolve(pluginRoot) === resolve(targetPath)) {
        await this.loadInstalledPlugin(targetPath, wsPort, deviceInfo)
        const installed = this.pluginInfo.get(pluginId)
        if (!installed) throw new Error('Plugin reloaded but did not load')
        return {
          pluginId: installed.pluginId,
          pluginName: installed.pluginName,
          pluginDir: installed.pluginDir,
          actionCount: installed.actions.size,
          running: Array.from(this.instances.values()).some((instance) => instance.uuid === installed.pluginId),
        }
      }
      if (existsSync(targetPath)) await rm(targetPath, { recursive: true, force: true })
      await cp(pluginRoot, stagingPath, { recursive: true })
      await rename(stagingPath, targetPath)
      await this.loadInstalledPlugin(targetPath, wsPort, deviceInfo)

      const installed = this.pluginInfo.get(pluginId)
      if (!installed) throw new Error('Plugin installed but did not load')
      return {
        pluginId: installed.pluginId,
        pluginName: installed.pluginName,
        pluginDir: installed.pluginDir,
        actionCount: installed.actions.size,
        running: Array.from(this.instances.values()).some((instance) => instance.uuid === installed.pluginId),
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  }

  async uninstallPlugin(pluginId: string): Promise<void> {
    const info = this.pluginInfo.get(pluginId)
    if (!info) throw new Error(`Plugin not found: ${pluginId}`)
    this.stopPluginById(pluginId)
    this.pluginInfo.delete(pluginId)
    await rm(info.pluginDir, { recursive: true, force: true })
  }

  private stopPluginById(pluginId: string): void {
    for (const [pluginUUID, instance] of Array.from(this.instances.entries())) {
      if (instance.uuid !== pluginId) continue
      instance.process.kill()
      this.instances.delete(pluginUUID)
    }
  }

  private async readManifest(pluginDir: string): Promise<Manifest> {
    const manifestPath = join(pluginDir, 'manifest.json')
    if (!existsSync(manifestPath)) throw new Error(`manifest.json not found in ${pluginDir}`)
    return JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
  }

  private async findPluginRoot(dir: string): Promise<string> {
    const directManifest = join(dir, 'manifest.json')
    if (existsSync(directManifest)) return dir
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = join(dir, entry.name)
      if (existsSync(join(candidate, 'manifest.json'))) return candidate
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const nested = await this.findPluginRoot(join(dir, entry.name)).catch(() => '')
      if (nested) return nested
    }
    throw new Error('No .sdPlugin folder with manifest.json found')
  }

  private async copyToNamedPluginDir(source: string, tempRoot: string, dirName: string): Promise<string> {
    const target = join(tempRoot, dirName)
    await rm(target, { recursive: true, force: true })
    await cp(source, target, { recursive: true })
    return target
  }

  private safePluginDirName(value: string): string {
    const safe = value.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '')
    if (!safe) throw new Error('Invalid plugin name')
    return safe
  }

  getPiPath(pluginId: string, actionId: string): string {
    const info = this.pluginInfo.get(pluginId)
    return info?.actions.get(actionId)?.piFile ?? info?.defaultPiPath ?? ''
  }

  getIconFilePath(pluginId: string, actionId: string): string | undefined {
    const info = this.pluginInfo.get(pluginId)
    if (!info) return undefined
    const iconRelative = info.actions.get(actionId)?.icon
    if (!iconRelative) return undefined
    // Manifest icons are usually extension-less; try common asset extensions.
    const base = join(info.pluginDir, iconRelative)
    const candidates = [
      `${base}.png`, `${base}@2x.png`,
      `${base}.svg`,
      `${base}.webp`, `${base}.jpg`, `${base}.jpeg`,
      base,
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    return undefined
  }

  getStateImageFilePath(pluginId: string, actionId: string, state: number): string | undefined {
    const info = this.pluginInfo.get(pluginId)
    if (!info) return undefined
    const imageRelative = info.actions.get(actionId)?.stateImages[state]
    if (!imageRelative) return undefined
    // States[n].Image is usually extension-less; try common asset extensions.
    const base = join(info.pluginDir, imageRelative)
    const candidates = [
      `${base}.png`, `${base}@2x.png`,
      `${base}.svg`,
      `${base}.webp`, `${base}.jpg`, `${base}.jpeg`,
      base,
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    return undefined
  }

  getActions(): PluginActionInfo[] {
    return Array.from(this.pluginInfo.values())
      .flatMap((info) => Array.from(info.actions.values()))
      .sort((a, b) => `${a.pluginName}:${a.name}`.localeCompare(`${b.pluginName}:${b.name}`))
  }

  actionSupportsController(pluginId: string, actionId: string, controller: 'Keypad' | 'Encoder'): boolean {
    const action = this.pluginInfo.get(pluginId)?.actions.get(actionId)
    if (!action) return false
    return action.controllers.includes(controller)
  }

  getAction(pluginId: string, actionId: string): PluginActionInfo | undefined {
    return this.pluginInfo.get(pluginId)?.actions.get(actionId)
  }

  getApplicationsToMonitor(): string[] {
    return Array.from(new Set(
      Array.from(this.pluginInfo.values()).flatMap((info) => info.applicationsToMonitor),
    )).sort((a, b) => a.localeCompare(b))
  }

  getPluginUUID(pluginId: string): string | undefined {
    for (const instance of this.instances.values()) {
      if (instance.uuid === pluginId) return instance.pluginUUID
    }
  }

  getPluginIdByPluginUUID(pluginUUID: string): string | undefined {
    return this.instances.get(pluginUUID)?.uuid
  }

  async appendPluginLog(pluginUUID: string, message: string): Promise<void> {
    const pluginId = this.getPluginIdByPluginUUID(pluginUUID)
    if (!pluginId) return
    await mkdir(this.logsDir, { recursive: true })
    const ts = new Date().toISOString()
    await appendFile(join(this.logsDir, `${pluginId}.log`), `[${ts}] ${message}\n`, 'utf8')
  }

  // pluginUUID hier = de random UUID van de WebSocket verbinding
  async getGlobalSettings(pluginUUID: string): Promise<Record<string, unknown>> {
    if (this.globalSettings.has(pluginUUID)) {
      return this.globalSettings.get(pluginUUID)!
    }
    // Zoek de manifest UUID op basis van pluginUUID
    const instance = this.instances.get(pluginUUID)
    if (!instance) return {}

    const path = join(this.settingsDir, `${instance.uuid}.json`)
    try {
      const raw = await readFile(path, 'utf8')
      const settings = JSON.parse(raw)
      this.globalSettings.set(pluginUUID, settings)
      return settings
    } catch {
      return {}
    }
  }

  async setGlobalSettings(pluginUUID: string, settings: Record<string, unknown>): Promise<void> {
    this.globalSettings.set(pluginUUID, settings)
    const instance = this.instances.get(pluginUUID)
    if (!instance) return
    await mkdir(this.settingsDir, { recursive: true })
    await writeFile(join(this.settingsDir, `${instance.uuid}.json`), JSON.stringify(settings, null, 2))
  }

  stopAll(): void {
    for (const instance of this.instances.values()) {
      instance.process.kill()
    }
    this.instances.clear()
  }
}
