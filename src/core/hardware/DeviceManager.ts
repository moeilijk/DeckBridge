import { listStreamDecks, openStreamDeck } from '@elgato-stream-deck/node'
import type { StreamDeck } from '@elgato-stream-deck/node'
import { EventEmitter } from 'events'

export interface DeviceProfile {
  id: string
  name: string
  model: string
  columns: number
  rows: number
  buttonCount: number
  iconSize: number
  type: number
  dials?: number
}

export interface ButtonEvent {
  deviceId: string
  keyIndex: number
}

export interface DeviceLifecycleEvent {
  deviceId: string
  name: string
  model: string
  columns: number
  rows: number
  type: number
}

const DEVICE_PROFILES: Record<string, DeviceProfile> = {
  'streamdeck-xl': {
    id: 'deckbridge-xl-0',
    name: 'Stream Deck XL',
    model: 'streamdeck-xl',
    columns: 8,
    rows: 4,
    buttonCount: 32,
    iconSize: 96,
    type: 2,
  },
  'streamdeck-plus': {
    id: 'deckbridge-plus-0',
    name: 'Stream Deck +',
    model: 'streamdeck-plus',
    columns: 4,
    rows: 2,
    buttonCount: 8,
    iconSize: 120,
    type: 7,
    dials: 4,
  },
}

function getRequestedProfiles(): DeviceProfile[] {
  const raw = (process.env.DECKBRIDGE_DEVICE_PROFILE ?? '').trim().toLowerCase()
  if (raw === 'hardware') return []

  if (!raw) return [DEVICE_PROFILES['streamdeck-plus']]

  const requested = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const profiles: DeviceProfile[] = []
  for (const name of requested) {
    const profile = DEVICE_PROFILES[name]
    if (profile) {
      profiles.push(profile)
      continue
    }
    console.warn(`Onbekend DeckBridge device-profiel: ${raw}. Bekend: ${Object.keys(DEVICE_PROFILES).join(', ')}`)
  }
  return profiles
}

export class DeviceManager extends EventEmitter {
  private devices = new Map<string, StreamDeck>()
  private virtualDevices = new Map<string, DeviceProfile>()
  private brightnessMap = new Map<string, number>()
  private writeQueue: Promise<void> = Promise.resolve()

  async start(): Promise<void> {
    for (const requestedProfile of getRequestedProfiles()) {
      this.connectVirtualDevice(requestedProfile)
    }

    const found = await listStreamDecks()

    if (found.length === 0) {
      console.warn('Geen Stream Deck gevonden. Controleer udev regels en USB verbinding.')
      return
    }

    for (const info of found) {
      await this.connectDevice(info.path)
    }
  }

  async stop(): Promise<void> {
    for (const [id, device] of this.devices) {
      this.emit('deviceDidDisconnect', {
        deviceId: id,
        name: device.PRODUCT_NAME,
        model: device.MODEL,
        columns: this.getColumns(id),
        rows: this.getRows(id),
        type: this.getDeviceType(id),
      } satisfies DeviceLifecycleEvent)
      await device.close()
      console.log(`Device ${id} gesloten`)
    }
    this.devices.clear()
    for (const [id, profile] of this.virtualDevices) {
      this.emit('deviceDidDisconnect', {
        deviceId: id,
        name: profile.name,
        model: profile.model,
        columns: profile.columns,
        rows: profile.rows,
        type: profile.type,
      } satisfies DeviceLifecycleEvent)
      console.log(`Virtueel device ${id} gesloten`)
    }
    this.virtualDevices.clear()
  }

  private connectVirtualDevice(profile: DeviceProfile): void {
    this.virtualDevices.set(profile.id, profile)
    console.log(`Virtueel Stream Deck profiel actief: ${profile.name} (${profile.model})`)
    this.emit('deviceDidConnect', {
      deviceId: profile.id,
      name: profile.name,
      model: profile.model,
      columns: profile.columns,
      rows: profile.rows,
      type: profile.type,
    } satisfies DeviceLifecycleEvent)
  }

  private async connectDevice(path: string): Promise<void> {
    const deck = await openStreamDeck(path)
    const id = path

    deck.on('down', (control) => {
      if (control.type !== 'button') return
      this.emit('keyDown', { deviceId: id, keyIndex: control.index } satisfies ButtonEvent)
    })

    deck.on('up', (control) => {
      if (control.type !== 'button') return
      this.emit('keyUp', { deviceId: id, keyIndex: control.index } satisfies ButtonEvent)
    })

    deck.on('error', (err: unknown) => {
      console.error(`Device ${id} fout:`, err)
    })

    this.devices.set(id, deck)
    console.log(`Stream Deck verbonden: ${deck.PRODUCT_NAME} (${deck.MODEL})`)
    this.emit('deviceDidConnect', {
      deviceId: id,
      name: deck.PRODUCT_NAME,
      model: deck.MODEL,
      columns: this.getColumns(id),
      rows: this.getRows(id),
      type: this.getDeviceType(id),
    } satisfies DeviceLifecycleEvent)
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.writeQueue = this.writeQueue.then(fn).catch(() => {})
    return this.writeQueue
  }

  async setImage(deviceId: string, keyIndex: number, imageBuffer: Uint8Array): Promise<void> {
    const deck = this.devices.get(deviceId)
    if (!deck) return
    return this.enqueue(() => deck.fillKeyBuffer(keyIndex, imageBuffer, { format: 'rgb' }))
  }

  async setKeyColor(deviceId: string, keyIndex: number, r: number, g: number, b: number): Promise<void> {
    const deck = this.devices.get(deviceId)
    if (!deck) return
    return this.enqueue(() => deck.fillKeyColor(keyIndex, r, g, b))
  }

  async setBrightness(deviceId: string, percentage: number): Promise<void> {
    if (this.virtualDevices.has(deviceId)) {
      this.brightnessMap.set(deviceId, percentage)
      return
    }
    const deck = this.devices.get(deviceId)
    if (!deck) return
    this.brightnessMap.set(deviceId, percentage)
    return this.enqueue(() => deck.setBrightness(percentage))
  }

  getBrightness(deviceId: string): number {
    return this.brightnessMap.get(deviceId) ?? 70
  }

  getDeviceIds(): string[] {
    return [...Array.from(this.devices.keys()), ...Array.from(this.virtualDevices.keys())]
  }

  getDevice(deviceId: string): StreamDeck | undefined {
    return this.devices.get(deviceId)
  }

  async clearAll(): Promise<void> {
    this.writeQueue = Promise.resolve()
    for (const [, deck] of this.devices) {
      await this.enqueue(() => deck.clearPanel())
    }
  }

  getColumns(deviceId: string): number {
    const virtualDevice = this.virtualDevices.get(deviceId)
    if (virtualDevice) return virtualDevice.columns
    const deck = this.devices.get(deviceId)
    if (!deck) return 8
    const buttonControls = deck.CONTROLS.filter(c => c.type === 'button')
    return buttonControls.reduce((max, c) => Math.max(max, c.column + 1), 1)
  }

  getRows(deviceId: string): number {
    const virtualDevice = this.virtualDevices.get(deviceId)
    if (virtualDevice) return virtualDevice.rows
    const deck = this.devices.get(deviceId)
    if (!deck) return 4
    const buttonControls = deck.CONTROLS.filter(c => c.type === 'button')
    return buttonControls.reduce((max, c) => Math.max(max, c.row + 1), 1)
  }

  getButtonCount(deviceId: string): number {
    const virtualDevice = this.virtualDevices.get(deviceId)
    if (virtualDevice) return virtualDevice.buttonCount
    const deck = this.devices.get(deviceId)
    if (!deck) return 32
    return deck.CONTROLS.filter(c => c.type === 'button').length
  }

  getIconSize(deviceId: string): number {
    const virtualDevice = this.virtualDevices.get(deviceId)
    if (virtualDevice) return virtualDevice.iconSize
    return (this.devices.get(deviceId) as any)?.ICON_SIZE ?? 96
  }

  getDeviceName(deviceId: string): string {
    const virtualDevice = this.virtualDevices.get(deviceId)
    if (virtualDevice) return virtualDevice.name
    return this.devices.get(deviceId)?.PRODUCT_NAME ?? 'Stream Deck'
  }

  getDeviceModel(deviceId: string): string {
    const virtualDevice = this.virtualDevices.get(deviceId)
    if (virtualDevice) return virtualDevice.model
    return String(this.devices.get(deviceId)?.MODEL ?? 'unknown')
  }

  getDeviceType(deviceId: string): number {
    const virtualDevice = this.virtualDevices.get(deviceId)
    if (virtualDevice) return virtualDevice.type
    const deck = this.devices.get(deviceId)
    if (!deck) return 2
    const model = String(deck.MODEL).toLowerCase()
    const product = String(deck.PRODUCT_NAME).toLowerCase()
    if (model.includes('plus') || product.includes('+')) return 7
    if (model.includes('xl') || product.includes('xl')) return 2
    if (model.includes('mini') || product.includes('mini')) return 1
    return 0
  }

  getDialCount(deviceId: string): number {
    const virtualDevice = this.virtualDevices.get(deviceId)
    if (virtualDevice) return virtualDevice.dials ?? 0
    const deck = this.devices.get(deviceId)
    if (!deck) return 0
    return deck.CONTROLS.filter(c => c.type === 'encoder').length
  }
}
