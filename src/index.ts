import { DeviceManager } from './core/hardware/DeviceManager.js'
import { PluginServer } from './core/websocket/PluginServer.js'
import { PluginManager } from './core/plugins/PluginManager.js'
import { ProfileManager, type ButtonSlot } from './core/profiles/ProfileManager.js'
import { PropertyInspectorServer } from './core/pi/PropertyInspectorServer.js'
import { renderTitle, renderBlack } from './core/render/renderButton.js'
import { spawn } from 'child_process'
import sharp from 'sharp'
import { homedir } from 'os'
import { join } from 'path'

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
  const profileManager = new ProfileManager()
  const piServer = new PropertyInspectorServer()
  const loggedSetImageContexts = new Set<string>()
  const keyImages = new Map<string, string>()

  await deviceManager.start()
  await deviceManager.clearAll()
  await profileManager.load()
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
        state: 0,
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
        state: 0,
        isInMultiAction: false,
      },
    })
  }

  // ── Hardware events ──────────────────────────────────────────────────────────

  deviceManager.on('keyDown', (e) => {
    const slot = profileManager.getSlot(e.deviceId, e.keyIndex)
    if (!slot) return
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
        state: 0,
        userDesiredState: 0,
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
        state: 0,
        isInMultiAction: false,
      },
    })
  })

  // ── Plugin / PI registratie ──────────────────────────────────────────────────

  pluginServer.on('pluginRegistered', (uuid: string, type: string) => {
    if (type === 'plugin') {
      // Stuur willAppear voor elke knop van deze plugin
      for (const { deviceId, keyIndex, slot } of profileManager.getAllSlots()) {
        if (pluginManager.getPluginUUID(slot.pluginId) !== uuid) continue
        sendWillAppear(deviceId, keyIndex, slot)
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

    switch (msg.event) {

      // ── Display ──────────────────────────────────────────────────────────────

      case 'setTitle': {
        if (!context) break
        const loc = profileManager.getSlotByContext(context)
        if (!loc) break
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
        if (!loc) break
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
        console.log(`[plugin log]`, payload.message)
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
      pluginId:  slot.pluginId,
      actionId:  slot.actionId,
      context:   slot.context,
      settings:  slot.settings,
      piFile:    pluginManager.getPiPath(slot.pluginId, slot.actionId),
      imageDataUrl: keyImages.get(keyImageId(deviceId, keyIndex)),
    }))
  )
  piServer.setActionProvider(() => pluginManager.getActions())
  piServer.setPrimaryDeviceProvider(() => deviceManager.getDeviceIds()[0] ?? primaryDeviceId)
  piServer.setLayoutProvider(() => ({ columns: cols, rows, totalKeys }))
  piServer.setSlotMutationHandlers({
    assign: async ({ deviceId, keyIndex, pluginId, actionId }) => {
      const existing = profileManager.getSlot(deviceId, keyIndex)
      if (existing?.pluginId === pluginId && existing.actionId === actionId) return
      if (existing) sendWillDisappear(deviceId, keyIndex, existing)
      clearKeyImage(deviceId, keyIndex)
      await deviceManager.setKeyColor(deviceId, keyIndex, 0, 0, 0)

      const slot = profileManager.createSlot(deviceId, keyIndex, pluginId, actionId)
      await profileManager.save()
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

      profileManager.removeSlot(sourceDeviceId, sourceKeyIndex)
      if (targetSlot) profileManager.removeSlot(targetDeviceId, targetKeyIndex)
      profileManager.setSlot(targetDeviceId, targetKeyIndex, sourceSlot)
      if (targetSlot) profileManager.setSlot(sourceDeviceId, sourceKeyIndex, targetSlot)

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
  })

  await pluginManager.loadPlugins(pluginDir, pluginServer.getPort(), deviceInfo)

  const wsPort = pluginServer.getPort()
  const dashUrl = `${piServer.getDashboardUrl()}?wsPort=${wsPort}`
  console.log(`DeckBridge running — WS:${wsPort} PI:${piServer.getPort()}`)
  console.log(`Dashboard: ${dashUrl}`)

  process.on('SIGINT', async () => {
    pluginManager.stopAll()
    await deviceManager.stop()
    await pluginServer.stop()
    await piServer.stop()
    process.exit(0)
  })
}

main().catch(console.error)
