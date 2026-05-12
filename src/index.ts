import { DeviceManager } from './core/hardware/DeviceManager.js'
import { PluginServer } from './core/websocket/PluginServer.js'
import { PluginManager } from './core/plugins/PluginManager.js'
import { ProfileManager, type ButtonSlot } from './core/profiles/ProfileManager.js'
import { PropertyInspectorServer } from './core/pi/PropertyInspectorServer.js'
import { renderTitle, renderBlack } from './core/render/renderButton.js'
import { spawn, execFile } from 'child_process'
import sharp from 'sharp'
import { homedir } from 'os'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'

async function decodeImage(dataUrl: string, size: number): Promise<Uint8Array> {
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl
  const buf = Buffer.from(base64, 'base64')
  return sharp(buf).resize(size, size).removeAlpha().raw().toBuffer()
}

async function encodePreviewImage(rgb: Uint8Array, size: number): Promise<string> {
  const png = await sharp(Buffer.from(rgb), {
    raw: { width: size, height: size, channels: 3 },
  }).png().toBuffer()
  return `data:image/png;base64,${png.toString('base64')}`
}

function keyImageId(deviceId: string, keyIndex: number): string {
  return JSON.stringify([deviceId, keyIndex])
}

function getCoords(deviceId: string, keyIndex: number, deviceManager: DeviceManager) {
  const cols = deviceManager.getColumns(deviceId)
  return { column: keyIndex % cols, row: Math.floor(keyIndex / cols) }
}

async function main() {
  const deviceManager = new DeviceManager()
  const pluginServer = new PluginServer()
  const pluginManager = new PluginManager()
  const profileManager = new ProfileManager({ profileName: process.env.DECKBRIDGE_PROFILE ?? 'default' })
  const piServer = new PropertyInspectorServer()
  const loggedSetImageContexts = new Set<string>()
  const keyImages = new Map<string, string>()
  const debugPI = process.env.DECKBRIDGE_DEBUG_PI === '1'

  const SYSTEM_PLUGIN = 'com.deckbridge.system'
  const ACTION_NEXT_PAGE = 'com.deckbridge.system.nextpage'
  const ACTION_PREV_PAGE = 'com.deckbridge.system.prevpage'
  const ACTION_FOLDER = 'com.deckbridge.system.folder'
  const ACTION_BACK = 'com.deckbridge.system.back'
  const APP_IDENTIFIER = 'DeckBridge'

  await deviceManager.start()
  await deviceManager.clearAll()
  await profileManager.load()

  // --- Device settings (brightness) ---
  const configDir = join(homedir(), '.config', 'DeckBridge')
  const deviceSettingsPath = join(configDir, 'device-settings.json')
  function loadDeviceSettings(): { brightness: number } {
    try { return JSON.parse(readFileSync(deviceSettingsPath, 'utf-8')) } catch { return { brightness: 70 } }
  }
  function saveDeviceSettings(s: { brightness: number }): void {
    try { mkdirSync(configDir, { recursive: true }); writeFileSync(deviceSettingsPath, JSON.stringify(s, null, 2)) } catch { /* ignore */ }
  }
  const deviceSettings = loadDeviceSettings()
  // Apply saved brightness to all connected devices on startup
  for (const devId of deviceManager.getDeviceIds()) {
    await deviceManager.setBrightness(devId, deviceSettings.brightness)
  }

  // Sync nav buttons: prevpage only on pages >0, nextpage only on pages <last
  let profileDirty = false
  const primaryId = deviceManager.getDeviceIds()[0] ?? 'deckbridge-xl-0'
  const keysPerPage = deviceManager.getDeviceIds()[0]
    ? deviceManager.getColumns(deviceManager.getDeviceIds()[0]) * (deviceManager.getRows?.(deviceManager.getDeviceIds()[0]) ?? 4)
    : 32
  const NAV_KEY_NEXT = keysPerPage - 1
  const NAV_KEY_PREV = keysPerPage - 2

  function isCurrentViewLocation(loc: { pageIndex: number; folderId?: string }): boolean {
    return loc.pageIndex === profileManager.getActivePage() && loc.folderId === profileManager.getCurrentFolderId()
  }

  function isImmutableSystemSlot(slot: ButtonSlot): boolean {
    return slot.pluginId === SYSTEM_PLUGIN && slot.actionId !== ACTION_FOLDER
  }

  function getFolderIdFromSlot(slot: ButtonSlot): string | undefined {
    const raw = slot.settings?.folderId
    return typeof raw === 'string' && raw ? raw : undefined
  }

  function isFolderSlot(slot: ButtonSlot): boolean {
    return slot.pluginId === SYSTEM_PLUGIN && slot.actionId === ACTION_FOLDER && typeof slot.settings?.folderId === 'string'
  }

  function syncNavButtons(): void {
    const pageCount = profileManager.getPageCount()
    const savedPage = profileManager.getActivePage()
    const navDefs = [
      { key: NAV_KEY_NEXT, actionId: ACTION_NEXT_PAGE, needed: (pi: number) => pi < pageCount - 1 },
      { key: NAV_KEY_PREV, actionId: ACTION_PREV_PAGE, needed: (pi: number) => pi > 0 },
    ]
    for (let pi = 0; pi < pageCount; pi++) {
      profileManager.switchPage(pi)
      const slots = profileManager.getAllSlots()
      for (const { key, actionId, needed } of navDefs) {
        const existing = slots.find(s => s.slot.actionId === actionId && s.slot.pluginId === SYSTEM_PLUGIN)
        if (needed(pi) && !existing) {
          profileManager.createSlot(primaryId, key, SYSTEM_PLUGIN, actionId)
          profileDirty = true
        } else if (!needed(pi) && existing) {
          profileManager.removeSlot(existing.deviceId, existing.keyIndex)
          profileDirty = true
        }
      }
    }
    profileManager.switchPage(savedPage)
  }

  syncNavButtons()
  if (profileDirty) await profileManager.save()
  await pluginServer.start()

  const pluginDir = join(homedir(), '.config', 'DeckBridge', 'plugins')
  await piServer.start(pluginDir)

  function sendToSender(senderUUID: string, senderType: string, payload: Record<string, unknown>): void {
    if (senderType === 'propertyInspector') {
      pluginServer.sendToPropertyInspector(senderUUID, payload)
      return
    }
    pluginServer.sendToPlugin(senderUUID, payload)
  }

  async function updateKeyImage(deviceId: string, keyIndex: number, rgb: Uint8Array, size: number): Promise<void> {
    keyImages.set(keyImageId(deviceId, keyIndex), await encodePreviewImage(rgb, size))
  }

  function clearKeyImage(deviceId: string, keyIndex: number): void {
    keyImages.delete(keyImageId(deviceId, keyIndex))
  }

  function getSlotState(slot: ButtonSlot): number {
    return Number.isInteger(slot.state) && slot.state >= 0 ? slot.state : 0
  }

  async function renderDefaultIcon(deviceId: string, keyIndex: number, slot: ButtonSlot): Promise<void> {
    // Skip if there's already a cached image for this key (plugin already sent setImage)
    if (keyImages.has(keyImageId(deviceId, keyIndex))) return
    const iconPath = pluginManager.getStateImageFilePath(slot.pluginId, slot.actionId, getSlotState(slot))
    if (!iconPath) return
    try {
      const size = deviceManager.getIconSize(deviceId)
      const rgb = await sharp(iconPath).resize(size, size).removeAlpha().raw().toBuffer()
      // Only apply if still no image (plugin may have arrived first)
      if (keyImages.has(keyImageId(deviceId, keyIndex))) return
      await deviceManager.setImage(deviceId, keyIndex, rgb)
      await updateKeyImage(deviceId, keyIndex, rgb, size)
    } catch {
      // Icon file may be missing or corrupt — silently skip
    }
  }

  async function renderSystemSlot(deviceId: string, keyIndex: number, actionId: string): Promise<void> {
    const slot = profileManager.getSlot(deviceId, keyIndex)
    const size = deviceManager.getIconSize(deviceId)
    const activePage = profileManager.getActivePage()
    const pageCount = profileManager.getPageCount()
    const inFolder = profileManager.isInFolder()
    const s = size
    const cx = Math.round(s * 0.5)
    const ty = Math.round(s * 0.15)
    const by = Math.round(s * 0.60)
    const my = Math.round((ty + by) / 2)
    const lx = Math.round(s * 0.28)
    const rx = Math.round(s * 0.72)
    const pageLabel = `${activePage + 1}/${pageCount}`
    const pageSize = Math.round(s * 0.20)

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><rect width="${s}" height="${s}" fill="black"/></svg>`
    if (actionId === ACTION_NEXT_PAGE || actionId === ACTION_PREV_PAGE) {
      const triangle = actionId === ACTION_NEXT_PAGE
        ? `${lx},${ty} ${rx},${my} ${lx},${by}`
        : `${rx},${ty} ${lx},${my} ${rx},${by}`
      svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}">
        <rect width="${s}" height="${s}" fill="black"/>
        <polygon points="${triangle}" fill="#777777"/>
        <text x="${cx}" y="${Math.round(s * 0.88)}" text-anchor="middle" dominant-baseline="auto"
              fill="#555555" font-size="${pageSize}px" font-family="DejaVu Sans,Arial,sans-serif">${inFolder ? 'folder' : pageLabel}</text>
      </svg>`
    } else if (actionId === ACTION_BACK) {
      const triangle = `${rx},${ty} ${lx},${my} ${rx},${by}`
      svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}">
        <rect width="${s}" height="${s}" fill="black"/>
        <polygon points="${triangle}" fill="#c98b2a"/>
        <text x="${cx}" y="${Math.round(s * 0.88)}" text-anchor="middle" dominant-baseline="auto"
              fill="#9b6d22" font-size="${Math.round(s * 0.18)}px" font-family="DejaVu Sans,Arial,sans-serif">Back</text>
      </svg>`
    } else if (actionId === ACTION_FOLDER) {
      const folderColor = typeof slot?.settings?.folderColor === 'string' ? slot.settings.folderColor : '#7f8694'
      const folderLabelRaw = typeof slot?.settings?.folderName === 'string' ? slot.settings.folderName : 'Folder'
      const folderLabel = folderLabelRaw.length > 10 ? `${folderLabelRaw.slice(0, 10)}` : folderLabelRaw
      const topY = Math.round(s * 0.25)
      const tabW = Math.round(s * 0.22)
      const tabH = Math.round(s * 0.10)
      const bodyY = Math.round(s * 0.36)
      const bodyH = Math.round(s * 0.34)
      const bodyX = Math.round(s * 0.16)
      const bodyW = Math.round(s * 0.68)
      svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}">
        <rect width="${s}" height="${s}" fill="black"/>
        <rect x="${bodyX}" y="${topY}" width="${tabW}" height="${tabH}" rx="3" fill="#6f7480"/>
        <rect x="${bodyX}" y="${bodyY}" width="${bodyW}" height="${bodyH}" rx="6" fill="${folderColor}"/>
        <text x="${cx}" y="${Math.round(s * 0.88)}" text-anchor="middle" dominant-baseline="auto"
              fill="#5d6470" font-size="${Math.round(s * 0.16)}px" font-family="DejaVu Sans,Arial,sans-serif">${folderLabel}</text>
      </svg>`
    }
    const rgb = await sharp(Buffer.from(svg)).resize(s, s).removeAlpha().raw().toBuffer()
    await deviceManager.setImage(deviceId, keyIndex, rgb)
    await updateKeyImage(deviceId, keyIndex, rgb, s)
  }

  async function renderCurrentView(clearPanel: boolean): Promise<void> {
    if (clearPanel) {
      keyImages.clear()
      await deviceManager.clearAll()
    }
    for (const { deviceId, keyIndex, slot } of profileManager.getAllSlots()) {
      if (slot.pluginId === SYSTEM_PLUGIN) {
        await renderSystemSlot(deviceId, keyIndex, slot.actionId)
      } else {
        await renderDefaultIcon(deviceId, keyIndex, slot)
        sendWillAppear(deviceId, keyIndex, slot)
      }
    }
    if (profileManager.isInFolder()) {
      await renderSystemSlot(primaryId, NAV_KEY_NEXT, ACTION_BACK)
    }
  }

  async function switchView(
    change: () => { oldSlots: Array<{ deviceId: string; keyIndex: number; slot: ButtonSlot }>; newSlots: Array<{ deviceId: string; keyIndex: number; slot: ButtonSlot }> } | null,
  ): Promise<void> {
    const result = change()
    if (!result) return
    for (const s of result.oldSlots) {
      if (s.slot.pluginId !== SYSTEM_PLUGIN) sendWillDisappear(s.deviceId, s.keyIndex, s.slot)
    }
    await profileManager.save()
    await renderCurrentView(true)
  }

  async function applyCachedKeyImage(deviceId: string, keyIndex: number): Promise<void> {
    const imageDataUrl = keyImages.get(keyImageId(deviceId, keyIndex))
    if (!imageDataUrl) {
      await deviceManager.setKeyColor(deviceId, keyIndex, 0, 0, 0)
      return
    }
    const size = deviceManager.getIconSize(deviceId)
    const rgb = await decodeImage(imageDataUrl, size)
    await deviceManager.setImage(deviceId, keyIndex, rgb)
  }

  async function applyCachedKeyImages(keys: Array<{ deviceId: string; keyIndex: number }>): Promise<void> {
    for (const key of keys) {
      await applyCachedKeyImage(key.deviceId, key.keyIndex)
    }
  }

  function resolvePluginUUIDForSender(senderUUID: string, senderType: string, context?: string): string | undefined {
    if (senderType !== 'propertyInspector') return senderUUID
    const loc = profileManager.getSlotByContext(context ?? senderUUID)
    if (!loc) return undefined
    return pluginManager.getPluginUUID(loc.slot.pluginId)
  }

  function sendWillAppear(deviceId: string, keyIndex: number, slot: ButtonSlot): void {
    const pluginUUID = pluginManager.getPluginUUID(slot.pluginId)
    if (!pluginUUID) return
    pluginServer.sendToPlugin(pluginUUID, {
      event: 'willAppear',
      action: slot.actionId,
      context: slot.context,
      device: deviceId,
      payload: {
        settings: slot.settings,
        coordinates: getCoords(deviceId, keyIndex, deviceManager),
        state: getSlotState(slot),
        isInMultiAction: false,
      },
    })
  }

  function sendWillDisappear(deviceId: string, keyIndex: number, slot: ButtonSlot): void {
    const pluginUUID = pluginManager.getPluginUUID(slot.pluginId)
    if (!pluginUUID) return
    pluginServer.sendToPlugin(pluginUUID, {
      event: 'willDisappear',
      action: slot.actionId,
      context: slot.context,
      device: deviceId,
      payload: {
        settings: slot.settings,
        coordinates: getCoords(deviceId, keyIndex, deviceManager),
        state: getSlotState(slot),
        isInMultiAction: false,
      },
    })
  }

  function allPluginUUIDs(): string[] {
    return pluginManager.getActions()
      .map((a) => pluginManager.getPluginUUID(a.pluginId))
      .filter((uuid): uuid is string => Boolean(uuid))
      .filter((uuid, index, arr) => arr.indexOf(uuid) === index)
  }

  function broadcastToAllPlugins(payload: Record<string, unknown>): void {
    for (const uuid of allPluginUUIDs()) {
      pluginServer.sendToPlugin(uuid, payload)
    }
  }

  function deviceEventPayload(deviceId: string): Record<string, unknown> {
    return {
      id: deviceId,
      name: 'Stream Deck',
      size: { columns: deviceManager.getColumns(deviceId), rows: deviceManager.getRows(deviceId) },
      type: 2,
    }
  }

  function getMonitoredApplications(): string[] {
    const fromManifest = pluginManager.getApplicationsToMonitor()
    const fromEnv = (process.env.DECKBRIDGE_MONITOR_APPS ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
    return Array.from(new Set([...fromManifest, ...fromEnv]))
  }

  function listRunningProcessNames(): Promise<Set<string>> {
    return new Promise((resolve) => {
      execFile('ps', ['-eo', 'comm='], { encoding: 'utf8' }, (err, stdout) => {
        if (err) {
          resolve(new Set())
          return
        }
        const names = stdout
          .split('\n')
          .map((v) => v.trim())
          .filter(Boolean)
        resolve(new Set(names))
      })
    })
  }

  function createApplicationMonitor(): { stop: () => void } {
    const intervalMs = Number(process.env.DECKBRIDGE_APP_MONITOR_MS ?? 1500)
    let previous = new Set<string>()
    let timer: NodeJS.Timeout | undefined
    let running = false

    const tick = async () => {
      if (running) return
      running = true
      try {
        const monitored = getMonitoredApplications()
        if (monitored.length === 0) {
          previous = new Set()
          return
        }

        const runningProcesses = await listRunningProcessNames()
        const current = new Set(monitored.filter((name) => runningProcesses.has(name)))

        for (const app of current) {
          if (!previous.has(app)) {
            broadcastToAllPlugins({
              event: 'applicationDidLaunch',
              payload: { application: app },
            })
          }
        }

        for (const app of previous) {
          if (!current.has(app)) {
            broadcastToAllPlugins({
              event: 'applicationDidTerminate',
              payload: { application: app },
            })
          }
        }

        previous = current
      } finally {
        running = false
      }
    }

    void tick()
    timer = setInterval(() => {
      void tick()
    }, intervalMs)

    return {
      stop: () => {
        if (timer) clearInterval(timer)
      },
    }
  }

  async function renderFeedback(deviceId: string, keyIndex: number, kind: 'ok' | 'alert'): Promise<void> {
    const previous = keyImages.get(keyImageId(deviceId, keyIndex))
    const size = deviceManager.getIconSize(deviceId)
    const fill = kind === 'ok' ? '#1f8f4a' : '#b73939'
    const strokePath = kind === 'ok' ? 'M25 52 L44 69 L73 35' : 'M49 24 L49 57 M49 71 L49 74'
    const strokeWidth = kind === 'ok' ? 8 : 10
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <rect width="${size}" height="${size}" fill="black"/>
      <circle cx="${Math.round(size / 2)}" cy="${Math.round(size / 2)}" r="${Math.round(size * 0.33)}" fill="${fill}"/>
      <path d="${strokePath}" stroke="#ffffff" stroke-width="${Math.round((strokeWidth / 96) * size)}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`
    const rgb = await sharp(Buffer.from(svg)).resize(size, size).removeAlpha().raw().toBuffer()
    await deviceManager.setImage(deviceId, keyIndex, rgb)
    await updateKeyImage(deviceId, keyIndex, rgb, size)

    setTimeout(() => {
      if (!previous) return
      decodeImage(previous, size)
        .then((img) => {
          keyImages.set(keyImageId(deviceId, keyIndex), previous)
          return deviceManager.setImage(deviceId, keyIndex, img)
        })
        .catch(() => {})
    }, 900)
  }

  // ── Hardware events ──────────────────────────────────────────────────────────

  deviceManager.on('keyDown', (e) => {
    const slot = profileManager.getSlot(e.deviceId, e.keyIndex)
    if (!slot && profileManager.isInFolder() && e.deviceId === primaryId && e.keyIndex === NAV_KEY_NEXT) {
      const oldSlots = profileManager.getAllSlots()
      const changed = profileManager.exitFolder()
      if (!changed) return
      const newSlots = profileManager.getAllSlots()
      void switchView(() => ({ oldSlots, newSlots })).catch(console.error)
      return
    }
    if (!slot) return
    // System actions handled internally
    if (slot.pluginId === SYSTEM_PLUGIN) {
      if (slot.actionId === ACTION_FOLDER) {
        const folderId = getFolderIdFromSlot(slot)
        if (!folderId) return
        const oldSlots = profileManager.getAllSlots()
        const changed = profileManager.enterFolder(folderId)
        if (!changed) return
        const newSlots = profileManager.getAllSlots()
        void switchView(() => ({ oldSlots, newSlots })).catch(console.error)
        return
      }
      const activePage = profileManager.getActivePage()
      const pageCount = profileManager.getPageCount()
      let targetPage = -1
      if (slot.actionId === ACTION_NEXT_PAGE && activePage < pageCount - 1) targetPage = activePage + 1
      if (slot.actionId === ACTION_PREV_PAGE && activePage > 0) targetPage = activePage - 1
      if (targetPage >= 0) {
        void switchView(() => profileManager.switchPage(targetPage)).catch(console.error)
      }
      return
    }
    const pluginUUID = pluginManager.getPluginUUID(slot.pluginId)
    if (!pluginUUID) return
    pluginServer.sendToPlugin(pluginUUID, {
      event: 'keyDown',
      action: slot.actionId,
      context: slot.context,
      device: e.deviceId,
      payload: {
        settings: slot.settings,
        coordinates: getCoords(e.deviceId, e.keyIndex, deviceManager),
        state: getSlotState(slot),
        userDesiredState: getSlotState(slot),
        isInMultiAction: false,
      },
    })
  })

  deviceManager.on('keyUp', (e) => {
    const slot = profileManager.getSlot(e.deviceId, e.keyIndex)
    if (!slot) return
    const pluginUUID = pluginManager.getPluginUUID(slot.pluginId)
    if (!pluginUUID) return
    pluginServer.sendToPlugin(pluginUUID, {
      event: 'keyUp',
      action: slot.actionId,
      context: slot.context,
      device: e.deviceId,
      payload: {
        settings: slot.settings,
        coordinates: getCoords(e.deviceId, e.keyIndex, deviceManager),
        state: getSlotState(slot),
        isInMultiAction: false,
      },
    })
  })

  deviceManager.on('deviceDidConnect', (evt: { deviceId: string }) => {
    broadcastToAllPlugins({
      event: 'deviceDidConnect',
      deviceInfo: deviceEventPayload(evt.deviceId),
    })
  })

  deviceManager.on('deviceDidDisconnect', (evt: { deviceId: string }) => {
    broadcastToAllPlugins({
      event: 'deviceDidDisconnect',
      deviceInfo: deviceEventPayload(evt.deviceId),
    })
  })

  // ── Plugin / PI registratie ──────────────────────────────────────────────────

  pluginServer.on('pluginRegistered', (uuid: string, type: string) => {
    if (type === 'plugin') {
      // Stuur willAppear voor elke knop van deze plugin
      for (const { deviceId, keyIndex, slot } of profileManager.getAllSlots()) {
        if (slot.pluginId === SYSTEM_PLUGIN) continue
        if (pluginManager.getPluginUUID(slot.pluginId) !== uuid) continue
        sendWillAppear(deviceId, keyIndex, slot)
      }

      pluginServer.sendToPlugin(uuid, { event: 'systemDidWakeUp' })
      pluginServer.sendToPlugin(uuid, {
        event: 'applicationDidLaunch',
        payload: { application: APP_IDENTIFIER },
      })
      for (const id of deviceManager.getDeviceIds()) {
        pluginServer.sendToPlugin(uuid, {
          event: 'deviceDidConnect',
          deviceInfo: deviceEventPayload(id),
        })
      }
    }

    if (type === 'propertyInspector') {
      // uuid = context van de knop waarvoor de PI opent
      const loc = profileManager.getSlotByContext(uuid)
      if (!loc) return
      const pluginUUID = pluginManager.getPluginUUID(loc.slot.pluginId)
      if (!pluginUUID) return
      pluginServer.sendToPlugin(pluginUUID, {
        event: 'propertyInspectorDidAppear',
        action: loc.slot.actionId,
        context: uuid,
        device: loc.deviceId,
      })
    }
  })

  pluginServer.on('piClosed', (context: string) => {
    const loc = profileManager.getSlotByContext(context)
    if (!loc) return
    const pluginUUID = pluginManager.getPluginUUID(loc.slot.pluginId)
    if (!pluginUUID) return
    pluginServer.sendToPlugin(pluginUUID, {
      event: 'propertyInspectorDidDisappear',
      action: loc.slot.actionId,
      context,
      device: loc.deviceId,
    })
  })

  // ── Plugin / PI berichten ────────────────────────────────────────────────────

  pluginServer.on('pluginMessage', async (senderUUID: string, senderType: string, msg: Record<string, unknown>) => {
    const context = msg.context as string | undefined
    const payload = (msg.payload ?? {}) as Record<string, unknown>
    if (debugPI && senderType === 'propertyInspector') {
      const loc = context ? profileManager.getSlotByContext(context) : undefined
      console.log(`[PI-RUNTIME ${new Date().toISOString()}] from-pi`, JSON.stringify({
        senderUUID,
        event: msg.event,
        context,
        resolved: Boolean(loc),
        resolvedKey: loc ? { deviceId: loc.deviceId, keyIndex: loc.keyIndex, actionId: loc.slot.actionId } : null,
      }))
    }

    switch (msg.event) {

      // ── Display ──────────────────────────────────────────────────────────────

      case 'setTitle': {
        if (!context) break
        const loc = profileManager.getSlotByContext(context)
        if (!loc || !isCurrentViewLocation(loc)) break
        try {
          const size = deviceManager.getIconSize(loc.deviceId)
          const title = typeof payload.title === 'string' ? payload.title : ''
          const titleParams = (payload.titleParameters ?? {}) as Record<string, unknown>
          const rgb = title
            ? await renderTitle(size, title, {
                titleColor: titleParams.titleColor as string | undefined,
                fontSize: titleParams.fontSize as number | undefined,
                titleAlignment: titleParams.titleAlignment as 'top' | 'middle' | 'bottom' | undefined,
                fontStyle: titleParams.fontStyle as string | undefined,
              })
            : await renderBlack(size)
          await deviceManager.setImage(loc.deviceId, loc.keyIndex, rgb)
          await updateKeyImage(loc.deviceId, loc.keyIndex, rgb, size)
        } catch (err) {
          console.error('setTitle render fout:', err)
        }
        break
      }

      case 'setImage': {
        if (!context || typeof payload.image !== 'string') break
        const loc = profileManager.getSlotByContext(context)
        if (!loc || !isCurrentViewLocation(loc)) break
        try {
          if (!loggedSetImageContexts.has(context)) {
            console.log(`setImage: key ${loc.keyIndex} ${loc.slot.actionId} (${payload.image.length} chars)`)
            loggedSetImageContexts.add(context)
          }
          const size = deviceManager.getIconSize(loc.deviceId)
          const rgb = await decodeImage(payload.image, size)
          await deviceManager.setImage(loc.deviceId, loc.keyIndex, rgb)
          await updateKeyImage(loc.deviceId, loc.keyIndex, rgb, size)
        } catch (err) {
          console.error('setImage fout:', err)
        }
        break
      }

      case 'setState': {
        if (!context) break
        const loc = profileManager.getSlotByContext(context)
        if (!loc) break
        const nextState = Number(payload.state)
        if (!Number.isInteger(nextState) || nextState < 0) break
        if (loc.slot.state === nextState) break
        loc.slot.state = nextState
        profileManager.save().catch(console.error)
        clearKeyImage(loc.deviceId, loc.keyIndex)
        if (isCurrentViewLocation(loc)) {
          await renderDefaultIcon(loc.deviceId, loc.keyIndex, loc.slot)
        }
        break
      }

      // ── Settings ─────────────────────────────────────────────────────────────

      case 'setSettings': {
        if (!context) break
        const loc = profileManager.getSlotByContext(context)
        if (!loc) break
        loc.slot.settings = payload
        profileManager.setSlot(loc.deviceId, loc.keyIndex, loc.slot)
        profileManager.save().catch(console.error)
        const targetUUID = pluginManager.getPluginUUID(loc.slot.pluginId)
        const didReceiveSettings = {
          event: 'didReceiveSettings',
          action: loc.slot.actionId,
          context,
          device: loc.deviceId,
          payload: {
            settings: loc.slot.settings,
            coordinates: getCoords(loc.deviceId, loc.keyIndex, deviceManager),
          },
        }
        if (targetUUID) pluginServer.sendToPlugin(targetUUID, didReceiveSettings)
        if (senderType === 'propertyInspector') {
          pluginServer.sendToPropertyInspector(senderUUID, didReceiveSettings)
        }
        break
      }

      case 'getSettings': {
        if (!context) break
        const loc = profileManager.getSlotByContext(context)
        if (!loc) break
        sendToSender(senderUUID, senderType, {
          event: 'didReceiveSettings',
          action: loc.slot.actionId,
          context,
          device: loc.deviceId,
          payload: {
            settings: loc.slot.settings,
            coordinates: getCoords(loc.deviceId, loc.keyIndex, deviceManager),
          },
        })
        break
      }

      case 'setGlobalSettings': {
        const targetUUID = resolvePluginUUIDForSender(senderUUID, senderType, context)
        if (!targetUUID) break
        await pluginManager.setGlobalSettings(targetUUID, payload)
        sendToSender(senderUUID, senderType, {
          event: 'didReceiveGlobalSettings',
          payload: { settings: payload },
        })
        break
      }

      case 'getGlobalSettings': {
        const targetUUID = resolvePluginUUIDForSender(senderUUID, senderType, context)
        if (!targetUUID) break
        const settings = await pluginManager.getGlobalSettings(targetUUID)
        sendToSender(senderUUID, senderType, {
          event: 'didReceiveGlobalSettings',
          payload: { settings },
        })
        break
      }

      // ── PI communicatie ───────────────────────────────────────────────────────

      case 'sendToPropertyInspector': {
        // plugin → PI
        if (!context) break
        pluginServer.sendToPropertyInspector(context, {
          event: 'sendToPropertyInspector',
          action: msg.action,
          context,
          payload,
        })
        break
      }

      case 'sendToPlugin': {
        // PI → plugin
        if (!context) break
        const loc = profileManager.getSlotByContext(context)
        if (!loc) break
        const targetUUID = pluginManager.getPluginUUID(loc.slot.pluginId)
        if (!targetUUID) break
        pluginServer.sendToPlugin(targetUUID, {
          event: 'sendToPlugin',
          action: loc.slot.actionId,
          context,
          payload,
        })
        break
      }

      // ── Overig ───────────────────────────────────────────────────────────────

      case 'logMessage': {
        const message = typeof payload.message === 'string' ? payload.message : JSON.stringify(payload)
        console.log(`[plugin log]`, message)
        const targetUUID = resolvePluginUUIDForSender(senderUUID, senderType, context)
        if (targetUUID) {
          await pluginManager.appendPluginLog(targetUUID, message)
        }
        break
      }

      case 'showAlert': {
        if (!context) break
        const loc = profileManager.getSlotByContext(context)
        if (!loc || !isCurrentViewLocation(loc)) break
        await renderFeedback(loc.deviceId, loc.keyIndex, 'alert')
        break
      }

      case 'showOk': {
        if (!context) break
        const loc = profileManager.getSlotByContext(context)
        if (!loc || !isCurrentViewLocation(loc)) break
        await renderFeedback(loc.deviceId, loc.keyIndex, 'ok')
        break
      }

      case 'switchToProfile': {
        const profileName: unknown = payload.profile
        if (typeof profileName === 'string' && profileName.trim()) {
          // Load the named profile, then optionally jump to the requested page.
          const oldSlots = profileManager.getAllSlots()
          await profileManager.switchProfile(profileName.trim())
          await profileManager.save()
          for (const s of oldSlots) {
            if (s.slot.pluginId !== SYSTEM_PLUGIN) sendWillDisappear(s.deviceId, s.keyIndex, s.slot)
          }
          keyImages.clear()
          await renderCurrentView(true)
          const pageValue: unknown = payload.pageNumber ?? payload.page
          if (typeof pageValue === 'number' && Number.isInteger(pageValue)) {
            const pageIndex = Math.max(0, pageValue)
            await switchView(() => profileManager.switchPage(pageIndex))
          }
        } else {
          const pageValue: unknown = payload.pageNumber ?? payload.page
          if (typeof pageValue !== 'number' || !Number.isInteger(pageValue)) break
          const pageIndex = Math.max(0, pageValue)
          await switchView(() => profileManager.switchPage(pageIndex))
        }
        break
      }

      case 'openUrl': {
        if (typeof payload.url === 'string') {
          spawn('xdg-open', [payload.url], { detached: true, stdio: 'ignore' }).unref()
        }
        break
      }

      default:
        console.log(`[${senderType}] event: ${msg.event}`, JSON.stringify(msg).slice(0, 200))
    }
  })

  // ── Plugin laden ─────────────────────────────────────────────────────────────

  const deviceIds = deviceManager.getDeviceIds()
  const deviceInfo = {
    id: deviceIds[0] ?? 'deckbridge-xl-0',
    name: 'Stream Deck XL',
    size: {
      columns: deviceIds[0] ? deviceManager.getColumns(deviceIds[0]) : 8,
      rows: deviceIds[0] ? deviceManager.getRows(deviceIds[0]) : 4,
    },
    type: 2,
  }

  // Wire up dashboard providers
  const primaryDeviceId = deviceIds[0] ?? 'deckbridge-xl-0'
  const cols = deviceIds[0] ? deviceManager.getColumns(deviceIds[0]) : 8
  const rows = deviceIds[0] ? deviceManager.getRows(deviceIds[0]) : 4
  const totalKeys = deviceIds[0] ? deviceManager.getButtonCount(deviceIds[0]) : cols * rows

  piServer.setSlotProvider(() =>
    profileManager.getAllSlots().map(({ deviceId, keyIndex, slot }) => ({
      deviceId,
      keyIndex,
      pluginId:   slot.pluginId,
      actionId:   slot.actionId,
      context:    slot.context,
      settings:   slot.settings,
      state:      getSlotState(slot),
      piFile:     pluginManager.getPiPath(slot.pluginId, slot.actionId),
      imageDataUrl: keyImages.get(keyImageId(deviceId, keyIndex)),
      isSystem:   isImmutableSystemSlot(slot),
    }))
  )
  piServer.setActionProvider(() => pluginManager.getActions())
  piServer.setPrimaryDeviceProvider(() => deviceManager.getDeviceIds()[0] ?? primaryDeviceId)
  piServer.setLayoutProvider(() => ({ columns: cols, rows, totalKeys }))
  piServer.setSlotMutationHandlers({
    assign: async ({ deviceId, keyIndex, pluginId, actionId, settings }) => {
      const existing = profileManager.getSlot(deviceId, keyIndex)
      if (existing?.pluginId === pluginId && existing.actionId === actionId) return
      if (existing) sendWillDisappear(deviceId, keyIndex, existing)
      clearKeyImage(deviceId, keyIndex)
      await deviceManager.setKeyColor(deviceId, keyIndex, 0, 0, 0)

      const slot = profileManager.createSlot(deviceId, keyIndex, pluginId, actionId, settings)
      await profileManager.save()
      await renderDefaultIcon(deviceId, keyIndex, slot)
      sendWillAppear(deviceId, keyIndex, slot)
    },
    clear: async (deviceId, keyIndex) => {
      const existing = profileManager.getSlot(deviceId, keyIndex)
      if (!existing) return

      sendWillDisappear(deviceId, keyIndex, existing)
      profileManager.removeSlot(deviceId, keyIndex)
      await profileManager.save()
      await deviceManager.setKeyColor(deviceId, keyIndex, 0, 0, 0)
      clearKeyImage(deviceId, keyIndex)
    },
    move: async ({ sourceDeviceId, sourceKeyIndex, targetDeviceId, targetKeyIndex }) => {
      if (sourceDeviceId === targetDeviceId && sourceKeyIndex === targetKeyIndex) return

      const sourceSlot = profileManager.getSlot(sourceDeviceId, sourceKeyIndex)
      if (!sourceSlot) return

      const targetSlot = profileManager.getSlot(targetDeviceId, targetKeyIndex)
      const sourceImageKey = keyImageId(sourceDeviceId, sourceKeyIndex)
      const targetImageKey = keyImageId(targetDeviceId, targetKeyIndex)
      const sourceImage = keyImages.get(sourceImageKey)
      const targetImage = keyImages.get(targetImageKey)

      sendWillDisappear(sourceDeviceId, sourceKeyIndex, sourceSlot)
      if (targetSlot) sendWillDisappear(targetDeviceId, targetKeyIndex, targetSlot)

      const move = profileManager.moveSlot(sourceDeviceId, sourceKeyIndex, targetDeviceId, targetKeyIndex)
      if (!move.moved) return

      if (sourceImage) keyImages.set(targetImageKey, sourceImage)
      else keyImages.delete(targetImageKey)

      if (targetSlot && targetImage) keyImages.set(sourceImageKey, targetImage)
      else keyImages.delete(sourceImageKey)

      await profileManager.save()
      await applyCachedKeyImages([
        { deviceId: sourceDeviceId, keyIndex: sourceKeyIndex },
        { deviceId: targetDeviceId, keyIndex: targetKeyIndex },
      ])

      sendWillAppear(targetDeviceId, targetKeyIndex, sourceSlot)
      if (targetSlot) sendWillAppear(sourceDeviceId, sourceKeyIndex, targetSlot)
    },

    switchPage: async (pageIndex) => {
      const result = profileManager.switchPage(pageIndex)
      if (!result) return
      for (const { deviceId, keyIndex, slot } of result.oldSlots) {
        if (slot.pluginId !== SYSTEM_PLUGIN) sendWillDisappear(deviceId, keyIndex, slot)
      }
      await profileManager.save()
      await renderCurrentView(true)
    },

    addPage: async (afterIndex?: number) => {
      const savedPage = profileManager.getActivePage()
      const prevLast = afterIndex ?? profileManager.getPageCount() - 1
      const newIndex = profileManager.addPage(afterIndex)
      // New page only gets prevpage (it's never the first page)
      profileManager.switchPage(newIndex)
      profileManager.createSlot(primaryId, NAV_KEY_PREV, SYSTEM_PLUGIN, ACTION_PREV_PAGE)
      // Previously-last page now needs nextpage (it has a next for the first time)
      profileManager.switchPage(prevLast)
      if (!profileManager.getAllSlots().some(s => s.slot.actionId === ACTION_NEXT_PAGE && s.slot.pluginId === SYSTEM_PLUGIN)) {
        profileManager.createSlot(primaryId, NAV_KEY_NEXT, SYSTEM_PLUGIN, ACTION_NEXT_PAGE)
        if (savedPage === prevLast) {
          const nextSlot = profileManager.getAllSlots().find(s => s.slot.actionId === ACTION_NEXT_PAGE && s.slot.pluginId === SYSTEM_PLUGIN)
          if (nextSlot) await renderSystemSlot(nextSlot.deviceId, nextSlot.keyIndex, ACTION_NEXT_PAGE)
        }
      }
      // Re-render current page nav (pageCount changed, so x/y label updates)
      profileManager.switchPage(savedPage)
      await renderCurrentView(false)
      await profileManager.save()
      return newIndex
    },

    removePage: async (pageIndex) => {
      // Send willDisappear for slots on the page being removed
      const removing = profileManager.getSlotsForPage(pageIndex)
      for (const { deviceId, keyIndex, slot } of removing) {
        if (slot.pluginId !== SYSTEM_PLUGIN) sendWillDisappear(deviceId, keyIndex, slot)
      }
      const wasActive = profileManager.getActivePage() === pageIndex
      profileManager.removePage(pageIndex)
      syncNavButtons()
      if (wasActive) {
        await renderCurrentView(true)
      }
      await profileManager.save()
    },
  })

  piServer.setFolderHandlers({
    create: async (deviceId, keyIndex) => {
      const existing = profileManager.getSlot(deviceId, keyIndex)
      if (existing && existing.pluginId !== SYSTEM_PLUGIN) sendWillDisappear(deviceId, keyIndex, existing)
      if (existing) profileManager.removeSlot(deviceId, keyIndex)

      const folderId = profileManager.createFolder(deviceId, keyIndex)
      const folderSlot = profileManager.getSlot(deviceId, keyIndex)
      if (folderSlot) {
        folderSlot.settings.folderName = 'Folder'
        folderSlot.settings.folderColor = '#7f8694'
        profileManager.setSlot(deviceId, keyIndex, folderSlot)
        await renderSystemSlot(deviceId, keyIndex, ACTION_FOLDER)
      }
      await profileManager.save()
      return folderId
    },
    enter: async (folderId) => {
      const oldSlots = profileManager.getAllSlots()
      const changed = profileManager.enterFolder(folderId)
      if (!changed) return
      const newSlots = profileManager.getAllSlots()
      await switchView(() => ({ oldSlots, newSlots }))
    },
    exit: async () => {
      const oldSlots = profileManager.getAllSlots()
      const changed = profileManager.exitFolder()
      if (!changed) return
      const newSlots = profileManager.getAllSlots()
      await switchView(() => ({ oldSlots, newSlots }))
    },
    updateSettings: async ({ deviceId, keyIndex, folderName, folderColor }) => {
      const slot = profileManager.getSlot(deviceId, keyIndex)
      if (!slot || slot.pluginId !== SYSTEM_PLUGIN || slot.actionId !== ACTION_FOLDER) return
      slot.settings.folderName = (folderName && folderName.trim()) ? folderName.trim().slice(0, 24) : 'Folder'
      if (folderColor && /^#[0-9a-fA-F]{6}$/.test(folderColor)) slot.settings.folderColor = folderColor
      profileManager.setSlot(deviceId, keyIndex, slot)
      await profileManager.save()
      if (isCurrentViewLocation({ pageIndex: profileManager.getActivePage(), folderId: profileManager.getCurrentFolderId() })) {
        await renderSystemSlot(deviceId, keyIndex, ACTION_FOLDER)
      }
    },
  })

  piServer.setPageProvider(() => ({
    activePage: profileManager.getActivePage(),
    pageCount: profileManager.getPageCount(),
  }))

  piServer.setViewProvider(() => ({
    inFolder: profileManager.isInFolder(),
    folderId: profileManager.getCurrentFolderId(),
    navDepth: profileManager.getNavDepth(),
  }))

  piServer.setUndoRedoHandlers({
    undo: async () => {
      const ok = profileManager.undo()
      if (ok) { keyImages.clear(); await renderCurrentView(true) }
      return ok
    },
    redo: async () => {
      const ok = profileManager.redo()
      if (ok) { keyImages.clear(); await renderCurrentView(true) }
      return ok
    },
    state: () => ({ canUndo: profileManager.canUndo(), canRedo: profileManager.canRedo() }),
  })

  piServer.setBrightnessHandlers({
    set: async (deviceId: string, value: number) => {
      await deviceManager.setBrightness(deviceId, value)
      deviceSettings.brightness = value
      saveDeviceSettings(deviceSettings)
    },
    get: (deviceId: string) => deviceManager.getBrightness(deviceId),
  })

  await pluginManager.loadPlugins(pluginDir, pluginServer.getPort(), deviceInfo)

  const appMonitor = createApplicationMonitor()

  await renderCurrentView(false)

  const wsPort = pluginServer.getPort()
  const dashUrl = `${piServer.getDashboardUrl()}?wsPort=${wsPort}`
  console.log(`DeckBridge running — WS:${wsPort} PI:${piServer.getPort()}`)
  console.log(`Dashboard: ${dashUrl}`)

  process.on('SIGCONT', () => {
    broadcastToAllPlugins({ event: 'systemDidWakeUp' })
  })

  process.on('SIGINT', async () => {
    appMonitor.stop()
    broadcastToAllPlugins({
      event: 'applicationDidTerminate',
      payload: { application: APP_IDENTIFIER },
    })
    pluginManager.stopAll()
    await deviceManager.stop()
    await pluginServer.stop()
    await piServer.stop()
    process.exit(0)
  })
}

main().catch(console.error)
