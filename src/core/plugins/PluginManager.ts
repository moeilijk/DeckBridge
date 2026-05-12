import { readdir, readFile, writeFile, mkdir, appendFile } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'
import { spawn, ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'

interface ManifestAction {
  UUID: string
  Name?: string
  Tooltip?: string
  Icon?: string
  PropertyInspectorPath?: string
  States?: { Image?: string }[]
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

  private parseApplicationsToMonitor(value: Manifest['ApplicationsToMonitor']): string[] {
    if (!value) return []
    const normalize = (items: string[]): string[] => items
      .map((v) => v.trim())
      .filter(Boolean)

    if (Array.isArray(value)) return normalize(value)
    return normalize(value.linux ?? value.mac ?? value.windows ?? [])
  }

  async loadPlugins(pluginDir: string, wsPort: number, deviceInfo: object): Promise<void> {
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

  private async loadPlugin(pluginDir: string, wsPort: number, deviceInfo: object): Promise<void> {
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
      devices: [deviceInfo],
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
          this.spawnPlugin(pluginId, pluginUUID, pluginDir, binPath, args)
          return
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
    const proc = spawn(cmd, args, {
      cwd: pluginDir,
      stdio: 'pipe',
      env: { ...process.env, ...extraEnv },
    })

    proc.stdout?.on('data', (d) => process.stdout.write(`[${uuid}] ${d}`))
    proc.stderr?.on('data', (d) => process.stderr.write(`[${uuid}] ${d}`))
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
