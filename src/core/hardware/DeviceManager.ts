import { listStreamDecks, openStreamDeck } from '@elgato-stream-deck/node'
import type { StreamDeck } from '@elgato-stream-deck/node'
import { EventEmitter } from 'events'

export interface ButtonEvent {
  deviceId: string
  keyIndex: number
}

export class DeviceManager extends EventEmitter {
  private devices = new Map<string, StreamDeck>()
  private writeQueue: Promise<void> = Promise.resolve()

  async start(): Promise<void> {
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
      await device.close()
      console.log(`Device ${id} gesloten`)
    }
    this.devices.clear()
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
    const deck = this.devices.get(deviceId)
    if (!deck) return
    return this.enqueue(() => deck.setBrightness(percentage))
  }

  getDeviceIds(): string[] {
    return Array.from(this.devices.keys())
  }

  getDevice(deviceId: string): StreamDeck | undefined {
    return this.devices.get(deviceId)
  }

  async clearAll(): Promise<void> {
    for (const [, deck] of this.devices) {
      await this.enqueue(() => deck.clearPanel())
    }
  }

  getColumns(deviceId: string): number {
    const deck = this.devices.get(deviceId)
    if (!deck) return 8
    const buttonControls = deck.CONTROLS.filter(c => c.type === 'button')
    return buttonControls.reduce((max, c) => Math.max(max, c.column + 1), 1)
  }

  getRows(deviceId: string): number {
    const deck = this.devices.get(deviceId)
    if (!deck) return 4
    const buttonControls = deck.CONTROLS.filter(c => c.type === 'button')
    return buttonControls.reduce((max, c) => Math.max(max, c.row + 1), 1)
  }

  getButtonCount(deviceId: string): number {
    const deck = this.devices.get(deviceId)
    if (!deck) return 32
    return deck.CONTROLS.filter(c => c.type === 'button').length
  }

  getIconSize(deviceId: string): number {
    return (this.devices.get(deviceId) as any)?.ICON_SIZE ?? 96
  }
}
