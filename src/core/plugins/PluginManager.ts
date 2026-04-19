import { readdir, readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { spawn, ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'

interface Manifest {
  UUID: string
  Version: string
  Nodejs?: { Version: string }
  CodePath?: string
  CodePathMac?: string
  CodePathWin?: string
}

interface PluginInstance {
  uuid: string
  pluginUUID: string
  process: ChildProcess
  pluginDir: string
}

export class PluginManager {
  private instances = new Map<string, PluginInstance>()
  private globalSettings = new Map<string, Record<string, unknown>>()
  private settingsDir = join(homedir(), '.config', 'DeckBridge', 'settings')

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

    const pluginUUID = randomUUID()
    const infoJson = JSON.stringify({
      application: { language: 'en', platform: 'mac', platformVersion: '14.0', version: '7.3.0' },
      devicePixelRatio: 1,
      devices: [deviceInfo],
      plugin: { uuid: manifest.UUID, version: manifest.Version },
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

      this.spawnPlugin(manifest.UUID, pluginUUID, pluginDir, 'node', [entryPoint, ...args])
    } else {
      const codePath = manifest.CodePathWin ?? manifest.CodePath
      if (!codePath) return

      const exePath = join(pluginDir, codePath)
      if (!existsSync(exePath)) {
        console.error(`Plugin binary niet gevonden: ${exePath}`)
        return
      }

      const winePrefix = join(homedir(), '.config', 'DeckBridge', 'wine', manifest.UUID)
      await mkdir(winePrefix, { recursive: true })

      this.spawnPlugin(manifest.UUID, pluginUUID, pluginDir, 'wine', [exePath, ...args], {
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

  getPluginUUID(pluginId: string): string | undefined {
    for (const instance of this.instances.values()) {
      if (instance.uuid === pluginId) return instance.pluginUUID
    }
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
