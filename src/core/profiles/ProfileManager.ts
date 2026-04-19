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

interface SerializedSlot { deviceId: string; keyIndex: number; pluginId: string; actionId: string; context: string; settings: Record<string, unknown> }

interface ProfileData {
  activePage: number
  pages: Array<{ slots: SerializedSlot[] }>
}

interface ProfileManagerOptions {
  profileDir?: string
  profileName?: string
}

export interface SlotMoveResult {
  moved: boolean
  swapped: boolean
  sourceSlot?: ButtonSlot
  targetSlot?: ButtonSlot
}

type ContextLocation = { pageIndex: number; deviceId: string; keyIndex: number }

function profileKey(deviceId: string, keyIndex: number): string {
  return `${deviceId}|${keyIndex}`
}

function normalizeProfileName(profileName: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(profileName)) {
    throw new Error(`Invalid profile name: ${profileName}`)
  }
  return profileName
}

export class ProfileManager {
  private pages: Array<Map<string, ButtonSlot>> = [new Map()]
  private activePage = 0
  private contextIndex = new Map<string, ContextLocation>()
  private profilePath: string

  constructor(profileDirOrOptions?: string | ProfileManagerOptions) {
    const options = typeof profileDirOrOptions === 'string'
      ? { profileDir: profileDirOrOptions }
      : (profileDirOrOptions ?? {})
    const dir = options.profileDir ?? join(homedir(), '.config', 'DeckBridge', 'profiles')
    const profileName = normalizeProfileName(options.profileName ?? 'default')
    this.profilePath = join(dir, `${profileName}.json`)
  }

  // ── Persistence ───────────────────────────────────────────────────────────────

  async load(): Promise<void> {
    this.clear()
    if (!existsSync(this.profilePath)) return
    try {
      const raw = await readFile(this.profilePath, 'utf8')
      const data: unknown = JSON.parse(raw)
      this.deserialize(data)
    } catch {
      console.error('Kon profiel niet laden, leeg profiel gebruikt')
    }
  }

  private deserialize(data: unknown): void {
    // Legacy format: { slots: [...] }
    if (data && typeof data === 'object' && 'slots' in data && Array.isArray((data as { slots: unknown }).slots)) {
      const legacy = data as { slots: SerializedSlot[] }
      this.pages = [new Map()]
      this.activePage = 0
      for (const entry of legacy.slots) {
        this.setSlotOnPage(0, entry.deviceId, entry.keyIndex, {
          pluginId: entry.pluginId,
          actionId: entry.actionId,
          context: entry.context,
          settings: entry.settings ?? {},
        })
      }
      return
    }

    // Current format: { activePage, pages: [{ slots: [...] }] }
    const d = data as ProfileData
    if (!Array.isArray(d.pages) || d.pages.length === 0) return
    this.pages = d.pages.map(() => new Map())
    this.activePage = Math.min(d.activePage ?? 0, d.pages.length - 1)
    for (let pi = 0; pi < d.pages.length; pi++) {
      for (const entry of d.pages[pi].slots ?? []) {
        this.setSlotOnPage(pi, entry.deviceId, entry.keyIndex, {
          pluginId: entry.pluginId,
          actionId: entry.actionId,
          context: entry.context,
          settings: entry.settings ?? {},
        })
      }
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.profilePath), { recursive: true })
    const data: ProfileData = {
      activePage: this.activePage,
      pages: this.pages.map(page => ({
        slots: Array.from(page.entries()).map(([key, slot]) => {
          const sep = key.lastIndexOf('|')
          return {
            deviceId: key.slice(0, sep),
            keyIndex: parseInt(key.slice(sep + 1)),
            ...slot,
          }
        }),
      })),
    }
    await writeFile(this.profilePath, JSON.stringify(data, null, 2))
  }

  clear(): void {
    this.pages = [new Map()]
    this.activePage = 0
    this.contextIndex.clear()
  }

  // ── Page management ───────────────────────────────────────────────────────────

  getActivePage(): number { return this.activePage }

  getPageCount(): number { return this.pages.length }

  addPage(): number {
    this.pages.push(new Map())
    return this.pages.length - 1
  }

  removePage(pageIndex: number): boolean {
    if (this.pages.length <= 1 || pageIndex < 0 || pageIndex >= this.pages.length) return false
    // Remove context entries for this page
    for (const [ctx, loc] of this.contextIndex) {
      if (loc.pageIndex === pageIndex) this.contextIndex.delete(ctx)
      else if (loc.pageIndex > pageIndex) loc.pageIndex--
    }
    this.pages.splice(pageIndex, 1)
    if (this.activePage >= this.pages.length) this.activePage = this.pages.length - 1
    return true
  }

  /**
   * Switch active page. Returns the slots of the old and new page so the caller
   * can send willDisappear/willAppear events.
   */
  switchPage(pageIndex: number): { oldSlots: Array<{ deviceId: string; keyIndex: number; slot: ButtonSlot }>; newSlots: Array<{ deviceId: string; keyIndex: number; slot: ButtonSlot }> } | null {
    if (pageIndex < 0 || pageIndex >= this.pages.length || pageIndex === this.activePage) return null
    const oldSlots = this.getAllSlots()
    this.activePage = pageIndex
    const newSlots = this.getAllSlots()
    return { oldSlots, newSlots }
  }

  // ── Slot operations (active page) ─────────────────────────────────────────────

  getSlot(deviceId: string, keyIndex: number): ButtonSlot | undefined {
    return this.pages[this.activePage].get(profileKey(deviceId, keyIndex))
  }

  setSlot(deviceId: string, keyIndex: number, slot: ButtonSlot): void {
    this.setSlotOnPage(this.activePage, deviceId, keyIndex, slot)
  }

  removeSlot(deviceId: string, keyIndex: number): void {
    const page = this.pages[this.activePage]
    const key = profileKey(deviceId, keyIndex)
    const slot = page.get(key)
    if (slot) this.contextIndex.delete(slot.context)
    page.delete(key)
  }

  createSlot(deviceId: string, keyIndex: number, pluginId: string, actionId: string, settings: Record<string, unknown> = {}): ButtonSlot {
    const slot: ButtonSlot = { pluginId, actionId, context: randomUUID(), settings }
    this.setSlot(deviceId, keyIndex, slot)
    return slot
  }

  getSlotByContext(context: string): { pageIndex: number; deviceId: string; keyIndex: number; slot: ButtonSlot } | undefined {
    const loc = this.contextIndex.get(context)
    if (!loc) return undefined
    const slot = this.pages[loc.pageIndex]?.get(profileKey(loc.deviceId, loc.keyIndex))
    if (!slot) return undefined
    return { ...loc, slot }
  }

  getAllSlots(): Array<{ deviceId: string; keyIndex: number; slot: ButtonSlot }> {
    return Array.from(this.pages[this.activePage].entries()).map(([key, slot]) => {
      const sep = key.lastIndexOf('|')
      return { deviceId: key.slice(0, sep), keyIndex: parseInt(key.slice(sep + 1)), slot }
    }).sort((a, b) => a.deviceId.localeCompare(b.deviceId) || a.keyIndex - b.keyIndex)
  }

  getSlotsForPage(pageIndex: number): Array<{ deviceId: string; keyIndex: number; slot: ButtonSlot }> {
    if (pageIndex < 0 || pageIndex >= this.pages.length) return []
    return Array.from(this.pages[pageIndex].entries()).map(([key, slot]) => {
      const sep = key.lastIndexOf('|')
      return { deviceId: key.slice(0, sep), keyIndex: parseInt(key.slice(sep + 1)), slot }
    }).sort((a, b) => a.deviceId.localeCompare(b.deviceId) || a.keyIndex - b.keyIndex)
  }

  moveSlot(sourceDeviceId: string, sourceKeyIndex: number, targetDeviceId: string, targetKeyIndex: number): SlotMoveResult {
    if (sourceDeviceId === targetDeviceId && sourceKeyIndex === targetKeyIndex) {
      return { moved: false, swapped: false }
    }
    const sourceSlot = this.getSlot(sourceDeviceId, sourceKeyIndex)
    if (!sourceSlot) return { moved: false, swapped: false }
    const targetSlot = this.getSlot(targetDeviceId, targetKeyIndex)
    this.removeSlot(sourceDeviceId, sourceKeyIndex)
    if (targetSlot) this.removeSlot(targetDeviceId, targetKeyIndex)
    this.setSlot(targetDeviceId, targetKeyIndex, sourceSlot)
    if (targetSlot) this.setSlot(sourceDeviceId, sourceKeyIndex, targetSlot)
    return { moved: true, swapped: Boolean(targetSlot), sourceSlot, targetSlot }
  }

  // ── Internal ──────────────────────────────────────────────────────────────────

  private setSlotOnPage(pageIndex: number, deviceId: string, keyIndex: number, slot: ButtonSlot): void {
    const page = this.pages[pageIndex]
    const key = profileKey(deviceId, keyIndex)
    const previous = page.get(key)
    if (previous) this.contextIndex.delete(previous.context)
    page.set(key, slot)
    this.contextIndex.set(slot.context, { pageIndex, deviceId, keyIndex })
  }
}
