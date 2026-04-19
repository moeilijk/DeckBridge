import { DeviceManager } from './core/hardware/DeviceManager.js'
import { PluginServer } from './core/websocket/PluginServer.js'
import { PluginManager } from './core/plugins/PluginManager.js'
import { ProfileManager } from './core/profiles/ProfileManager.js'
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

  await deviceManager.start()
  await deviceManager.clearAll()
  await profileManager.load()
  await pluginServer.start()

  const pluginDir = join(homedir(), '.config', 'DeckBridge', 'plugins')
  await piServer.start(pluginDir)

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
        pluginServer.sendToPlugin(uuid, {
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
          const size = deviceManager.getIconSize(loc.deviceId)
          const rgb = await decodeImage(payload.image, size)
          await deviceManager.setImage(loc.deviceId, loc.keyIndex, rgb)
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
        break
      }

      case 'getSettings': {
        if (!context) break
        const loc = profileManager.getSlotByContext(context)
        if (!loc) break
        pluginServer.sendToPlugin(senderUUID, {
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
        await pluginManager.setGlobalSettings(senderUUID, payload)
        pluginServer.sendToPlugin(senderUUID, {
          event: 'didReceiveGlobalSettings',
          payload: { settings: payload },
        })
        break
      }

      case 'getGlobalSettings': {
        const settings = await pluginManager.getGlobalSettings(senderUUID)
        pluginServer.sendToPlugin(senderUUID, {
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
        console.log(`[${senderType} ${senderUUID}] onbekend event:`, msg.event)
    }
  })

  // ── Plugin laden ─────────────────────────────────────────────────────────────

  const deviceIds = deviceManager.getDeviceIds()
  const deviceInfo = {
    id: deviceIds[0] ?? 'deckbridge-xl-0',
    name: 'Stream Deck XL',
    size: { columns: deviceIds[0] ? deviceManager.getColumns(deviceIds[0]) : 8, rows: 4 },
    type: 2,
  }

  await pluginManager.loadPlugins(pluginDir, pluginServer.getPort(), deviceInfo)

  console.log(`DeckBridge running — WS:${pluginServer.getPort()} PI:${piServer.getPort()}`)

  process.on('SIGINT', async () => {
    pluginManager.stopAll()
    await deviceManager.stop()
    await pluginServer.stop()
    await piServer.stop()
    process.exit(0)
  })
}

main().catch(console.error)
