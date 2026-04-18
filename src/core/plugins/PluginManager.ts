import { readdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
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
      const codePath = manifest.CodePath
      if (!codePath) return

      const exePath = join(pluginDir, codePath)
      if (!existsSync(exePath)) {
        console.error(`Plugin binary niet gevonden: ${exePath}`)
        return
      }

      this.spawnPlugin(manifest.UUID, pluginUUID, pluginDir, 'wine', [exePath, ...args])
    }
  }

  private spawnPlugin(uuid: string, pluginUUID: string, pluginDir: string, cmd: string, args: string[]): void {
    const proc = spawn(cmd, args, { cwd: pluginDir, stdio: 'pipe' })

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

  stopAll(): void {
    for (const instance of this.instances.values()) {
      instance.process.kill()
    }
    this.instances.clear()
  }
}
