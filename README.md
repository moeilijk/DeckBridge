# DeckBridge

Drop-in vervanging voor de Elgato Stream Deck software op Linux. Zo compatibel mogelijk met bestaande marketplace plugins — hetzelfde WebSocket protocol, zelfde manifest formaat, zelfde API.

## Status

Vroege ontwikkeling. Stream Deck XL hardware, plugin runtime, Electron shell en
een eerste visuele profiel editor werken. Zie [docs/roadmap.md](docs/roadmap.md)
voor de actuele status.

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

Voor de desktop-app:

```bash
npm run dev:electron
```

Bij het starten print DeckBridge een lokale dashboard-URL, bijvoorbeeld:

```text
Dashboard: http://127.0.0.1:<pi-port>/dashboard?wsPort=<ws-port>
```

Daar kun je acties uit de action library naar Stream Deck tegels slepen, tegels
verwijderen, en de Property Inspector voor een tegel openen. Geconfigureerde
tegels tonen live dezelfde afbeelding die naar de knop op het apparaat is
gestuurd.

Dashboard interactie:

- Sleep een actie uit de action library naar een lege of bestaande tegel om die
  actie toe te wijzen.
- Sleep een bestaande tegel naar een andere tegel om ze te wisselen, of naar een
  lege plek om hem te verplaatsen.
- Klik op een geconfigureerde tegel om de Property Inspector te openen.
- Rechtermuisklik op een tegel toont een menu met verwijderen.

De Electron shell start dezelfde daemon als child process en laadt deze lokale
UI in een desktopvenster. Zie [docs/electron.md](docs/electron.md).

Profielen staan standaard in `~/.config/DeckBridge/profiles/default.json`.
Gebruik `DECKBRIDGE_PROFILE=<naam>` om een apart profielbestand
`<naam>.json` te gebruiken, bijvoorbeeld voor demo- of testprofielen zonder het
echte default-profiel te vervuilen.

## Plugin Compatibiliteit

DeckBridge implementeert het officiële Elgato Stream Deck WebSocket SDK protocol.

**Werkt:** Open-source plugins, oudere gearchiveerde plugins, cross-platform Node.js plugins.

**Werkt niet:** DRM-beveiligde marketplace plugins (vereist Elgato's key-infrastructure — zelfde beperking als OpenDeck).

## Architectuur

Zie [docs/architecture.md](docs/architecture.md) voor de volledige architectuurbeschrijving.

## Roadmap

Zie [docs/roadmap.md](docs/roadmap.md) voor de actuele roadmap en
[docs/planning.md](docs/planning.md) voor de uitgewerkte backlog en volgorde.

## Hergebruikte Libraries

- [`@elgato-stream-deck/node`](https://github.com/Julusian/node-elgato-stream-deck) — HID abstractie (MIT, Julusian)
- [`ws`](https://github.com/websockets/ws) — WebSocket server (MIT)

## Licentie

MIT
