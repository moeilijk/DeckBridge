// Convert an Elgato `.streamDeckProfile` into DeckBridge's on-disk profile format
// (profiles phase 3 — plugin-bundled profiles).
//
// A `.streamDeckProfile` is a zip containing `<UUID>.sdProfile/manifest.json`
// (the page order) plus `Profiles/<pageId>/manifest.json` per page. Each page has
// Controllers; the "Keypad" controller maps `"column,row"` → action, the "Encoder"
// controller maps a dial index → action. This module is the pure mapping of that
// already-parsed JSON to DeckBridge's `{ activePage, pages: [{ slots, folders }] }`
// shape, so it is unit-testable against a real sample without unzipping.

import { execFile } from 'child_process'
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const ENCODER_BASE_INDEX = 1000

export interface ElgatoAction {
  UUID?: string
  Settings?: Record<string, unknown>
  State?: number
}

export interface ElgatoController {
  Type?: string
  Actions?: Record<string, ElgatoAction>
}

export interface ElgatoPage {
  Controllers?: ElgatoController[]
}

export interface ElgatoTopManifest {
  Name?: string
  Pages?: { Pages?: string[]; Default?: string; Current?: string }
}

export interface ConvertedSlot {
  deviceId: string
  keyIndex: number
  pluginId: string
  actionId: string
  context: string
  settings: Record<string, unknown>
  state: number
}

export interface ConvertedProfile {
  activePage: number
  pages: Array<{ slots: ConvertedSlot[]; folders: [] }>
}

export interface ConvertOptions {
  /** UUID of the plugin shipping the profile — becomes slot.pluginId. */
  pluginId: string
  /** Target device id the slots are written for. */
  deviceId: string
  /** Device column count, used to flatten "column,row" to a key index. */
  columns: number
  top: ElgatoTopManifest
  /** pageId → parsed page manifest. */
  pages: Record<string, ElgatoPage>
  /** Context id generator (injected so the result is deterministic in tests). */
  newContext: () => string
}

function keypadKeyIndex(coord: string, columns: number): number | null {
  const [colStr, rowStr] = coord.split(',')
  const col = Number(colStr)
  const row = Number(rowStr)
  if (!Number.isInteger(col) || !Number.isInteger(row)) return null
  return row * columns + col
}

function encoderKeyIndex(coord: string): number | null {
  // Encoder coordinates are the dial index, sometimes written as "0" or "0,0".
  const index = Number(coord.split(',')[0])
  if (!Number.isInteger(index) || index < 0) return null
  return ENCODER_BASE_INDEX + index
}

function slotsForPage(page: ElgatoPage, opts: ConvertOptions): ConvertedSlot[] {
  const slots: ConvertedSlot[] = []
  for (const controller of page.Controllers ?? []) {
    const isEncoder = controller.Type === 'Encoder'
    for (const [coord, action] of Object.entries(controller.Actions ?? {})) {
      const actionId = action?.UUID
      if (typeof actionId !== 'string' || !actionId) continue
      const keyIndex = isEncoder ? encoderKeyIndex(coord) : keypadKeyIndex(coord, opts.columns)
      if (keyIndex === null) continue
      slots.push({
        deviceId: opts.deviceId,
        keyIndex,
        pluginId: opts.pluginId,
        actionId,
        context: opts.newContext(),
        settings: action.Settings && typeof action.Settings === 'object' ? action.Settings : {},
        state: Number.isInteger(action.State) ? (action.State as number) : 0,
      })
    }
  }
  return slots
}

export function convertStreamDeckProfile(opts: ConvertOptions): ConvertedProfile {
  const pageIds = (opts.top.Pages?.Pages && opts.top.Pages.Pages.length > 0)
    ? opts.top.Pages.Pages
    : Object.keys(opts.pages)
  const pages = pageIds
    .map((id) => opts.pages[id])
    .filter((page): page is ElgatoPage => Boolean(page))
    .map((page) => ({ slots: slotsForPage(page, opts), folders: [] as [] }))

  if (pages.length === 0) pages.push({ slots: [], folders: [] })
  return { activePage: 0, pages }
}

/** Map an Elgato DeviceType to the matching DeckBridge profile basename, if bundled. */
export const DEVICE_TYPE_TO_MODEL: Record<number, string> = {
  0: 'streamdeck',
  1: 'streamdeck-mini',
  2: 'streamdeck-xl',
  7: 'streamdeck-plus',
}

/**
 * Unzip an Elgato `.streamDeckProfile`, convert it, and write the result as a
 * DeckBridge profile JSON at `destPath`. Returns true on success. Pure I/O glue
 * around `convertStreamDeckProfile`, kept out of PluginManager so it is testable
 * with a real archive and without spawning a plugin.
 */
export async function deployStreamDeckProfileArchive(opts: {
  archivePath: string
  pluginId: string
  deviceId: string
  columns: number
  destPath: string
  newContext?: () => string
}): Promise<boolean> {
  if (!existsSync(opts.archivePath)) return false
  const tempRoot = await mkdtemp(join(tmpdir(), 'deckbridge-sdprofile-'))
  try {
    await execFileAsync('unzip', ['-q', opts.archivePath, '-d', tempRoot])
    const sdProfileDir = (await readdir(tempRoot)).find((entry) => entry.endsWith('.sdProfile'))
    if (!sdProfileDir) return false
    const base = join(tempRoot, sdProfileDir)
    const top = JSON.parse(await readFile(join(base, 'manifest.json'), 'utf8')) as ElgatoTopManifest
    const pages: Record<string, ElgatoPage> = {}
    for (const pageId of top.Pages?.Pages ?? []) {
      const pagePath = join(base, 'Profiles', pageId, 'manifest.json')
      if (existsSync(pagePath)) pages[pageId] = JSON.parse(await readFile(pagePath, 'utf8')) as ElgatoPage
    }
    const converted = convertStreamDeckProfile({
      pluginId: opts.pluginId,
      deviceId: opts.deviceId,
      columns: opts.columns,
      top,
      pages,
      newContext: opts.newContext ?? randomUUID,
    })
    await mkdir(dirname(opts.destPath), { recursive: true })
    await writeFile(opts.destPath, JSON.stringify(converted, null, 2))
    return true
  } catch (err) {
    console.error('Kon gebundeld profiel niet uitrollen:', err)
    return false
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}
