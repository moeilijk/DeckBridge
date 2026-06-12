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
  state: number
}

interface SerializedSlot { deviceId: string; keyIndex: number; pluginId: string; actionId: string; context: string; settings: Record<string, unknown>; state?: number }
interface SerializedFolder { folderId: string; slots: SerializedSlot[] }

interface ProfileData {
  activePage: number
  pages: Array<{ slots: SerializedSlot[]; folders?: SerializedFolder[] }>
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

type ContextLocation = { pageIndex: number; folderId?: string; deviceId: string; keyIndex: number }

// Current navigation view: page-level or inside a folder
export type NavView = { pageIndex: number; folderId?: string }

function profileKey(deviceId: string, keyIndex: number): string {
  return `${deviceId}|${keyIndex}`
}

function normalizeProfileName(profileName: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(profileName)) {
    throw new Error(`Invalid profile name: ${profileName}`)
  }
  return profileName
}

interface PageData {
  slots: Map<string, ButtonSlot>
  folders: Map<string, Map<string, ButtonSlot>>
}

export interface FolderEntry {
  folderId: string
  pageIndex: number
}

export class ProfileManager {
  private pages: PageData[] = [{ slots: new Map(), folders: new Map() }]
  private activePage = 0
  private contextIndex = new Map<string, ContextLocation>()
  private profilePath: string
  private profileDir: string
  // Navigation stack — empty = at page level; last entry = deepest folder
  private navStack: NavView[] = []
  // Undo/redo: two-stack model (undoStack + redoStack)
  private undoStack: ProfileData[] = []
  private redoStack: ProfileData[] = []
  private static readonly MAX_HISTORY = 50
  private _pauseHistory = false

  constructor(profileDirOrOptions?: string | ProfileManagerOptions) {
    const options = typeof profileDirOrOptions === 'string'
      ? { profileDir: profileDirOrOptions }
      : (profileDirOrOptions ?? {})
    const dir = options.profileDir ?? join(homedir(), '.config', 'DeckBridge', 'profiles')
    const profileName = normalizeProfileName(options.profileName ?? 'default')
    this.profileDir = dir
    this.profilePath = join(dir, `${profileName}.json`)
  }

  /** Switch to a different named profile in the same directory and reload. */
  async switchProfile(name: string): Promise<void> {
    this.profilePath = join(this.profileDir, `${normalizeProfileName(name)}.json`)
    await this.load()
  }

  getProfilePath(): string { return this.profilePath }

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
      this.pages = [{ slots: new Map(), folders: new Map() }]
      this.activePage = 0
      for (const entry of legacy.slots) {
        this.setSlotInMap(this.pages[0].slots, 0, undefined, entry.deviceId, entry.keyIndex, {
          pluginId: entry.pluginId, actionId: entry.actionId,
          context: entry.context, settings: entry.settings ?? {}, state: entry.state ?? 0,
        })
      }
      return
    }

    const d = data as ProfileData
    if (!Array.isArray(d.pages) || d.pages.length === 0) return
    this.pages = d.pages.map(() => ({ slots: new Map(), folders: new Map() }))
    this.activePage = Math.min(d.activePage ?? 0, d.pages.length - 1)
    for (let pi = 0; pi < d.pages.length; pi++) {
      for (const entry of d.pages[pi].slots ?? []) {
        this.setSlotInMap(this.pages[pi].slots, pi, undefined, entry.deviceId, entry.keyIndex, {
          pluginId: entry.pluginId, actionId: entry.actionId,
          context: entry.context, settings: entry.settings ?? {}, state: entry.state ?? 0,
        })
      }
      for (const folder of d.pages[pi].folders ?? []) {
        const folderMap = new Map<string, ButtonSlot>()
        this.pages[pi].folders.set(folder.folderId, folderMap)
        for (const entry of folder.slots ?? []) {
          this.setSlotInMap(folderMap, pi, folder.folderId, entry.deviceId, entry.keyIndex, {
            pluginId: entry.pluginId, actionId: entry.actionId,
            context: entry.context, settings: entry.settings ?? {}, state: entry.state ?? 0,
          })
        }
      }
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.profilePath), { recursive: true })
    const data: ProfileData = {
      activePage: this.activePage,
      pages: this.pages.map(page => ({
        slots: slotsFromMap(page.slots),
        folders: Array.from(page.folders.entries()).map(([folderId, folderMap]) => ({
          folderId,
          slots: slotsFromMap(folderMap),
        })),
      })),
    }
    await writeFile(this.profilePath, JSON.stringify(data, null, 2))
  }

  clear(): void {
    this.pages = [{ slots: new Map(), folders: new Map() }]
    this.activePage = 0
    this.contextIndex.clear()
    this.navStack = []
  }

  // ── Page management ───────────────────────────────────────────────────────────

  getActivePage(): number { return this.activePage }

  getPageCount(): number { return this.pages.length }

  addPage(afterIndex?: number): number {
    this.pushHistory()
    const insertAt = (afterIndex !== undefined && afterIndex >= 0 && afterIndex < this.pages.length)
      ? afterIndex + 1
      : this.pages.length
    this.pages.splice(insertAt, 0, { slots: new Map(), folders: new Map() })
    for (const loc of this.contextIndex.values()) {
      if (loc.pageIndex >= insertAt) loc.pageIndex++
    }
    if (this.activePage >= insertAt) this.activePage++
    return insertAt
  }

  removePage(pageIndex: number): boolean {
    this.pushHistory()
    if (this.pages.length <= 1 || pageIndex < 0 || pageIndex >= this.pages.length) return false
    for (const [ctx, loc] of this.contextIndex) {
      if (loc.pageIndex === pageIndex) this.contextIndex.delete(ctx)
      else if (loc.pageIndex > pageIndex) loc.pageIndex--
    }
    this.pages.splice(pageIndex, 1)
    if (this.activePage >= this.pages.length) this.activePage = this.pages.length - 1
    this.navStack = []
    return true
  }

  switchPage(pageIndex: number): { oldSlots: Array<{ deviceId: string; keyIndex: number; slot: ButtonSlot }>; newSlots: Array<{ deviceId: string; keyIndex: number; slot: ButtonSlot }> } | null {
    if (pageIndex < 0 || pageIndex >= this.pages.length || pageIndex === this.activePage) return null
    const oldSlots = this.getAllSlots()
    this.activePage = pageIndex
    this.navStack = []
    const newSlots = this.getAllSlots()
    return { oldSlots, newSlots }
  }

  // ── Folder navigation ─────────────────────────────────────────────────────────

  getCurrentView(): NavView {
    return this.navStack.length > 0
      ? this.navStack[this.navStack.length - 1]
      : { pageIndex: this.activePage }
  }

  isInFolder(): boolean { return this.navStack.length > 0 }

  getCurrentFolderId(): string | undefined { return this.getCurrentView().folderId }

  getNavDepth(): number { return this.navStack.length }

  enterFolder(folderId: string): boolean {
    const page = this.pages[this.activePage]
    if (!page.folders.has(folderId)) return false
    this.navStack.push({ pageIndex: this.activePage, folderId })
    return true
  }

  exitFolder(): boolean {
    if (this.navStack.length === 0) return false
    this.navStack.pop()
    return true
  }

  exitAllFolders(): void { this.navStack = [] }

  // Creates a folder slot in the current visible view.
  createFolder(deviceId: string, keyIndex: number): string {
    this.pushHistory()
    this._pauseHistory = true
    const folderId = randomUUID()
    const page = this.pages[this.getCurrentView().pageIndex]
    page.folders.set(folderId, new Map())
    const slot: ButtonSlot = {
      pluginId: 'com.deckbridge.system',
      actionId: 'com.deckbridge.system.folder',
      context: randomUUID(),
      settings: { folderId },
      state: 0,
    }
    this.setSlot(deviceId, keyIndex, slot)
    this._pauseHistory = false
    return folderId
  }

  getFolderSlots(folderId: string): Array<{ deviceId: string; keyIndex: number; slot: ButtonSlot }> {
    const page = this.pages[this.activePage]
    const folderMap = page.folders.get(folderId)
    if (!folderMap) return []
    return slotsArrayFromMap(folderMap)
  }

  getFoldersForPage(pageIndex: number = this.activePage): FolderEntry[] {
    const page = this.pages[pageIndex]
    if (!page) return []
    return Array.from(page.folders.keys()).map((folderId) => ({ folderId, pageIndex }))
  }

  // ── Slot operations (current view = page or folder) ───────────────────────────

  private currentMap(): Map<string, ButtonSlot> {
    const view = this.getCurrentView()
    const page = this.pages[view.pageIndex]
    if (view.folderId) {
      const map = page.folders.get(view.folderId)
      if (map) return map
      // Should not happen in normal flow, but keep state consistent if a folder
      // was externally deleted while still present in navStack.
      const recovered = new Map<string, ButtonSlot>()
      page.folders.set(view.folderId, recovered)
      return recovered
    }
    return page.slots
  }

  getSlot(deviceId: string, keyIndex: number): ButtonSlot | undefined {
    return this.currentMap().get(profileKey(deviceId, keyIndex))
  }

  setSlot(deviceId: string, keyIndex: number, slot: ButtonSlot): void {
    this.pushHistory()
    const view = this.getCurrentView()
    const map = this.currentMap()
    this.setSlotInMap(map, view.pageIndex, view.folderId, deviceId, keyIndex, slot)
  }

  removeSlot(deviceId: string, keyIndex: number): void {
    this.pushHistory()
    const view = this.getCurrentView()
    const map = this.currentMap()
    const key = profileKey(deviceId, keyIndex)
    const slot = map.get(key)
    if (slot) {
      this.contextIndex.delete(slot.context)
      if (slot.pluginId === 'com.deckbridge.system' && slot.actionId === 'com.deckbridge.system.folder') {
        const folderId = typeof slot.settings.folderId === 'string' ? slot.settings.folderId : undefined
        if (folderId) this.removeFolderTree(view.pageIndex, folderId)
      }
    }
    map.delete(key)
  }

  removeSlotsForPlugin(pluginId: string): number {
    let removed = 0
    this.pushHistory()
    this._pauseHistory = true
    for (let pageIndex = 0; pageIndex < this.pages.length; pageIndex++) {
      removed += this.removeSlotsForPluginFromMap(this.pages[pageIndex].slots, pageIndex, pluginId)
      for (const folderMap of this.pages[pageIndex].folders.values()) {
        removed += this.removeSlotsForPluginFromMap(folderMap, pageIndex, pluginId)
      }
    }
    this._pauseHistory = false
    if (removed === 0) {
      this.undoStack.pop()
    }
    return removed
  }

  createSlot(deviceId: string, keyIndex: number, pluginId: string, actionId: string, settings: Record<string, unknown> = {}): ButtonSlot {
    const slot: ButtonSlot = { pluginId, actionId, context: randomUUID(), settings, state: 0 }
    this.setSlot(deviceId, keyIndex, slot)
    return slot
  }

  getSlotByContext(context: string): { pageIndex: number; folderId?: string; deviceId: string; keyIndex: number; slot: ButtonSlot } | undefined {
    const loc = this.contextIndex.get(context)
    if (!loc) return undefined
    const page = this.pages[loc.pageIndex]
    const map = loc.folderId ? page?.folders.get(loc.folderId) : page?.slots
    const slot = map?.get(profileKey(loc.deviceId, loc.keyIndex))
    if (!slot) return undefined
    return { ...loc, slot }
  }

  getAllSlots(): Array<{ deviceId: string; keyIndex: number; slot: ButtonSlot }> {
    return slotsArrayFromMap(this.currentMap())
  }

  getSlotsForPage(pageIndex: number): Array<{ deviceId: string; keyIndex: number; slot: ButtonSlot }> {
    if (pageIndex < 0 || pageIndex >= this.pages.length) return []
    return slotsArrayFromMap(this.pages[pageIndex].slots)
  }

  moveSlot(sourceDeviceId: string, sourceKeyIndex: number, targetDeviceId: string, targetKeyIndex: number): SlotMoveResult {
    if (sourceDeviceId === targetDeviceId && sourceKeyIndex === targetKeyIndex) {
      return { moved: false, swapped: false }
    }
    const sourceSlot = this.getSlot(sourceDeviceId, sourceKeyIndex)
    if (!sourceSlot) return { moved: false, swapped: false }
    this.pushHistory()
    this._pauseHistory = true
    const targetSlot = this.getSlot(targetDeviceId, targetKeyIndex)
    this.removeSlot(sourceDeviceId, sourceKeyIndex)
    if (targetSlot) this.removeSlot(targetDeviceId, targetKeyIndex)
    this.setSlot(targetDeviceId, targetKeyIndex, sourceSlot)
    if (targetSlot) this.setSlot(sourceDeviceId, sourceKeyIndex, targetSlot)
    this._pauseHistory = false
    return { moved: true, swapped: Boolean(targetSlot), sourceSlot, targetSlot }
  }

  // ── Internal ──────────────────────────────────────────────────────────────────

  // ── Undo/redo ─────────────────────────────────────────────────────────────────

  canUndo(): boolean { return this.undoStack.length > 0 }
  canRedo(): boolean { return this.redoStack.length > 0 }

  undo(): boolean {
    if (!this.canUndo()) return false
    this.redoStack.push(this.snapshot())
    const prev = this.undoStack.pop()!
    this._pauseHistory = true
    this.clear()
    this.deserialize(prev)
    this._pauseHistory = false
    return true
  }

  redo(): boolean {
    if (!this.canRedo()) return false
    this.undoStack.push(this.snapshot())
    const next = this.redoStack.pop()!
    this._pauseHistory = true
    this.clear()
    this.deserialize(next)
    this._pauseHistory = false
    return true
  }

  private snapshot(): ProfileData {
    return {
      activePage: this.activePage,
      pages: this.pages.map(page => ({
        slots: slotsFromMap(page.slots),
        folders: Array.from(page.folders.entries()).map(([folderId, folderMap]) => ({
          folderId,
          slots: slotsFromMap(folderMap),
        })),
      })),
    }
  }

  private pushHistory(): void {
    if (this._pauseHistory) return
    this.undoStack.push(this.snapshot())
    if (this.undoStack.length > ProfileManager.MAX_HISTORY) this.undoStack.shift()
    this.redoStack = []
  }

  private setSlotInMap(map: Map<string, ButtonSlot>, pageIndex: number, folderId: string | undefined, deviceId: string, keyIndex: number, slot: ButtonSlot): void {
    const key = profileKey(deviceId, keyIndex)
    const previous = map.get(key)
    if (previous) {
      this.contextIndex.delete(previous.context)
      if (previous.pluginId === 'com.deckbridge.system' && previous.actionId === 'com.deckbridge.system.folder') {
        const prevFolderId = typeof previous.settings.folderId === 'string' ? previous.settings.folderId : undefined
        if (prevFolderId) this.removeFolderTree(pageIndex, prevFolderId)
      }
    }
    map.set(key, slot)
    this.contextIndex.set(slot.context, { pageIndex, folderId, deviceId, keyIndex })
  }

  private removeFolderTree(pageIndex: number, folderId: string): void {
    const page = this.pages[pageIndex]
    const folderMap = page?.folders.get(folderId)
    if (!folderMap) return
    for (const nestedSlot of folderMap.values()) {
      this.contextIndex.delete(nestedSlot.context)
      if (nestedSlot.pluginId === 'com.deckbridge.system' && nestedSlot.actionId === 'com.deckbridge.system.folder') {
        const nestedFolderId = typeof nestedSlot.settings.folderId === 'string' ? nestedSlot.settings.folderId : undefined
        if (nestedFolderId) this.removeFolderTree(pageIndex, nestedFolderId)
      }
    }
    page.folders.delete(folderId)
    this.navStack = this.navStack.filter((entry) => entry.folderId !== folderId)
  }

  private removeSlotsForPluginFromMap(map: Map<string, ButtonSlot>, pageIndex: number, pluginId: string): number {
    let removed = 0
    for (const [key, slot] of Array.from(map.entries())) {
      if (slot.pluginId !== pluginId) continue
      this.contextIndex.delete(slot.context)
      if (slot.pluginId === 'com.deckbridge.system' && slot.actionId === 'com.deckbridge.system.folder') {
        const folderId = typeof slot.settings.folderId === 'string' ? slot.settings.folderId : undefined
        if (folderId) this.removeFolderTree(pageIndex, folderId)
      }
      map.delete(key)
      removed++
    }
    return removed
  }
}

function slotsFromMap(map: Map<string, ButtonSlot>): SerializedSlot[] {
  return Array.from(map.entries()).map(([key, slot]) => {
    const sep = key.lastIndexOf('|')
    return { deviceId: key.slice(0, sep), keyIndex: parseInt(key.slice(sep + 1)), ...slot }
  }).sort((a, b) => a.deviceId.localeCompare(b.deviceId) || a.keyIndex - b.keyIndex)
}

function slotsArrayFromMap(map: Map<string, ButtonSlot>): Array<{ deviceId: string; keyIndex: number; slot: ButtonSlot }> {
  return Array.from(map.entries()).map(([key, slot]) => {
    const sep = key.lastIndexOf('|')
    return { deviceId: key.slice(0, sep), keyIndex: parseInt(key.slice(sep + 1)), slot }
  }).sort((a, b) => a.deviceId.localeCompare(b.deviceId) || a.keyIndex - b.keyIndex)
}
