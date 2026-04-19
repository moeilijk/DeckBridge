import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'

export interface ButtonSlot {
  pluginId: string
  actionId: string
  context: string
  settings: Record<string, unknown>
}

interface ProfileData {
  slots: Array<{ deviceId: string; keyIndex: number } & ButtonSlot>
}

export class ProfileManager {
  private slots = new Map<string, ButtonSlot>()
  private contextIndex = new Map<string, { deviceId: string; keyIndex: number }>()
  private profilePath: string

  constructor(profileDir?: string) {
    const dir = profileDir ?? join(homedir(), '.config', 'DeckBridge', 'profiles')
    this.profilePath = join(dir, 'default.json')
  }

  async load(): Promise<void> {
    if (!existsSync(this.profilePath)) return
    try {
      const raw = await readFile(this.profilePath, 'utf8')
      const data: ProfileData = JSON.parse(raw)
      for (const entry of data.slots) {
        const { deviceId, keyIndex, ...slot } = entry
        this.setSlot(deviceId, keyIndex, slot)
      }
    } catch {
      console.error('Kon profiel niet laden, leeg profiel gebruikt')
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.profilePath), { recursive: true })
    const slots = this.getAllSlots().map(({ deviceId, keyIndex, slot }) => ({ deviceId, keyIndex, ...slot }))
    await writeFile(this.profilePath, JSON.stringify({ slots }, null, 2))
  }

  getSlot(deviceId: string, keyIndex: number): ButtonSlot | undefined {
    return this.slots.get(`${deviceId}|${keyIndex}`)
  }

  setSlot(deviceId: string, keyIndex: number, slot: ButtonSlot): void {
    const key = `${deviceId}|${keyIndex}`
    const previous = this.slots.get(key)
    if (previous) this.contextIndex.delete(previous.context)
    this.slots.set(key, slot)
    this.contextIndex.set(slot.context, { deviceId, keyIndex })
  }

  removeSlot(deviceId: string, keyIndex: number): void {
    const key = `${deviceId}|${keyIndex}`
    const slot = this.slots.get(key)
    if (slot) this.contextIndex.delete(slot.context)
    this.slots.delete(key)
  }

  getSlotByContext(context: string): { deviceId: string; keyIndex: number; slot: ButtonSlot } | undefined {
    const loc = this.contextIndex.get(context)
    if (!loc) return undefined
    const slot = this.slots.get(`${loc.deviceId}|${loc.keyIndex}`)
    if (!slot) return undefined
    return { ...loc, slot }
  }

  getAllSlots(): Array<{ deviceId: string; keyIndex: number; slot: ButtonSlot }> {
    return Array.from(this.slots.entries()).map(([key, slot]) => {
      const sep = key.lastIndexOf('|')
      return { deviceId: key.slice(0, sep), keyIndex: parseInt(key.slice(sep + 1)), slot }
    })
  }

  createSlot(deviceId: string, keyIndex: number, pluginId: string, actionId: string, settings: Record<string, unknown> = {}): ButtonSlot {
    const slot: ButtonSlot = { pluginId, actionId, context: randomUUID(), settings }
    this.setSlot(deviceId, keyIndex, slot)
    return slot
  }
}
