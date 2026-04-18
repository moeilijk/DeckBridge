# DeckBridge

Drop-in vervanging voor de Elgato Stream Deck software op Linux. Zo compatibel mogelijk met bestaande marketplace plugins — hetzelfde WebSocket protocol, zelfde manifest formaat, zelfde API.

## Status

Vroege ontwikkeling. Fase 1: Stream Deck XL hardware + knopfunctionaliteit.

## Vereisten

- Node.js 20 of 24
- Linux met udev
- Stream Deck apparaat (primaire target: XL)

### udev regel (vereist voor hardware toegang zonder root)

```bash
echo 'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0fd9", TAG+="uaccess"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0fd9", TAG+="uaccess"' | sudo tee /etc/udev/rules.d/70-streamdeck.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Koppel daarna het apparaat opnieuw aan.

## Installatie

```bash
npm install
npm run dev
```

## Plugin Compatibiliteit

DeckBridge implementeert het officiële Elgato Stream Deck WebSocket SDK protocol.

**Werkt:** Open-source plugins, oudere gearchiveerde plugins, cross-platform Node.js plugins.

**Werkt niet:** DRM-beveiligde marketplace plugins (vereist Elgato's key-infrastructure — zelfde beperking als OpenDeck).

## Architectuur

Zie [docs/architecture.md](docs/architecture.md) voor de volledige architectuurbeschrijving.

## Roadmap

Zie [docs/roadmap.md](docs/roadmap.md) voor de geplande fases.

## Hergebruikte Libraries

- [`@elgato-stream-deck/node`](https://github.com/Julusian/node-elgato-stream-deck) — HID abstractie (MIT, Julusian)
- [`ws`](https://github.com/websockets/ws) — WebSocket server (MIT)

## Licentie

MIT
