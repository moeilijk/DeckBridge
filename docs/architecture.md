# DeckBridge — Architectuur

## Overzicht

DeckBridge bestaat uit twee lagen die onafhankelijk kunnen draaien:

```
┌─────────────────────────────────────────────────────────┐
│  DeckBridge UI (Electron shell)                         │
│  - Desktopvenster                                       │
│  - Laadt lokale configuratie UI                         │
│  - Start/stopt core daemon                              │
└────────────────┬────────────────────────────────────────┘
                 │ child process + localhost HTTP
┌────────────────▼────────────────────────────────────────┐
│  DeckBridge Core Daemon (Node.js — fase 1)              │
│                                                         │
│  DeviceManager          PluginServer                    │
│  - @elgato-stream-deck  - ws WebSocket server           │
│  - HID communicatie     - UUID-gebaseerde routing       │
│  - Button events        - Plugin registratie            │
│                                                         │
│  PluginManager          ProfileManager                  │
│  - manifest.json lezen  - Profielen per apparaat        │
│  - Node.js plugins      - JSON persistentie             │
│  - .exe plugins (Wine)  - switchToProfile               │
└────────────────┬────────────────────────────────────────┘
                 │ child_process.spawn()
       ┌─────────┴─────────────────────┐
       │                               │
┌──────▼──────┐               ┌────────▼──────────┐
│ Plugin A    │               │ Plugin B (Node.js) │
│ (.exe/Wine) │               │ node bin/plugin.js │
│             │               │ -port X -uuid Y... │
└─────────────┘               └────────────────────┘
```

## Componenten

### DeviceManager (`src/core/hardware/`)

Verantwoordelijk voor alle hardware communicatie.

- Gebruikt `@elgato-stream-deck/node` (Julusian, MIT) als abstractielaag
- Detecteert aangesloten Stream Deck apparaten via HID
- Verwerkt button keyDown/keyUp events en stuurt ze naar de plugin pipeline
- Stuurt afbeeldingen naar individuele knoppen (base64 → JPEG → HID)
- Vereist udev regel `/etc/udev/rules.d/70-streamdeck.rules` voor non-root toegang

Ondersteunde modellen (via Julusian library):
- Stream Deck XL (primaire target, fase 1)
- Stream Deck Original, Mini, MK.2, +, Neo, Pedal (automatisch via library)

### PluginServer (`src/core/websocket/`)

De WebSocket server waarnaar plugins verbinding maken.

- Één server op een dynamisch gekozen poort
- Alle plugins verbinden op dezelfde poort — routing via UUID
- Implementeert het volledige Elgato WebSocket SDK protocol
- Handelt zowel plugin backend als Property Inspector verbindingen af

### PluginManager (`src/core/plugins/`)

Start en beheert plugin processen.

- Scant de plugin directory voor `*.sdPlugin` mappen
- Leest `manifest.json` per plugin
- **Node.js plugins:** `spawn('node', [codePath, '-port', port, '-pluginUUID', uuid, '-registerEvent', 'registerPlugin', '-info', infoJson])`
- **.exe plugins:** `spawn('wine', [exePath, '-port', port, ...])`
- Geeft de WebSocket poort door na server start

### ProfileManager (`src/core/profiles/`)

Beheert welke actie op welke knop zit, per apparaat.

- JSON-bestanden in `~/.config/DeckBridge/profiles/`
- Ondersteunt `switchToProfile` commando van plugins
- Koppelt button-index aan plugin actie UUID

### PropertyInspectorServer (`src/core/pi/`)

Serveert de lokale dashboard UI en Property Inspector bestanden.

- Dashboard endpoint: `/dashboard?wsPort=<ws-port>`
- State endpoint: `/api/state?wsPort=<ws-port>`
- Mutaties: `POST /api/slots` voor toewijzen, `DELETE /api/slots` voor
  verwijderen
- Injecteert een Stream Deck-achtige bootstrap in Property Inspector HTML zodat
  plugin-PI's via dezelfde WebSocket server kunnen registreren
- Publiceert acties uit plugin manifests als action library voor de UI
- Publiceert per tegel de laatste preview-afbeelding als `imageDataUrl`

De preview-afbeelding komt uit dezelfde raw RGB buffer die naar het apparaat
gaat. Bij `setImage` decodeert de core de plugin-afbeelding naar het
apparaatformaat; bij `setTitle` rendert de core tekst naar hetzelfde formaat.
Die buffer wordt naar `DeviceManager.setImage()` gestuurd en tegelijk als PNG
data URL in de dashboard state gezet. Daardoor toont de UI niet alleen de
profielmetadata, maar de actuele tegel zoals het apparaat die krijgt.

### Electron shell (`src/electron/`)

Verantwoordelijk voor de desktop-app.

- Start de gebouwde core daemon via `node dist/index.js`
- Leest stdout totdat de daemon de lokale dashboard-URL print
- Laadt die URL in een `BrowserWindow`
- Stuurt bij afsluiten `SIGINT` naar de core zodat plugins en hardware netjes
  worden gesloten
- Houdt native HID, Wine en plugin processen buiten Electron zelf

Zie [electron.md](electron.md) voor het procesmodel en de scripts.

## Plugin Communicatie Flow

```
Knopdruk op hardware
  → DeviceManager ontvangt keyDown (button index)
  → ProfileManager: welke actie UUID hoort bij deze knop?
  → PluginServer: stuur keyDown event naar juiste plugin (via UUID)
  → Plugin verwerkt event, stuurt bijv. setImage terug
  → PluginServer ontvangt setImage
  → Core decodeert/rendert naar raw RGB
  → DeviceManager stuurt afbeelding naar correcte knop
  → PropertyInspectorServer publiceert dezelfde afbeelding als UI preview
```

## Platform Field

In de `-info` JSON altijd `"platform": "mac"` gebruiken.
Reden: de officiële SDK kent geen `"linux"`. Veel plugins gebruiken Mac als cross-platform baseline. Plugins die expliciet `"windows"` vereisen, hebben sowieso Wine nodig.

## Bestandsstructuur

```
DeckBridge/
├── src/
│   ├── index.ts                        # Entry point — start daemon
│   └── core/
│       ├── hardware/
│       │   └── DeviceManager.ts        # HID / Stream Deck hardware
│       ├── websocket/
│       │   └── PluginServer.ts         # WebSocket server (plugin protocol)
│       ├── plugins/
│       │   └── PluginManager.ts        # Plugin loader & process manager
│       └── profiles/
│           └── ProfileManager.ts       # Profiel beheer
├── docs/
│   ├── research.md                     # Research bevindingen
│   ├── architecture.md                 # Dit bestand
│   ├── roadmap.md                      # Korte status en roadmap
│   └── planning.md                     # Uitgewerkte backlog
├── package.json
├── tsconfig.json
├── .gitignore
├── README.md
└── CLAUDE.md
```

## Dependency Keuzes

| Library | Versie | Reden |
|---|---|---|
| `@elgato-stream-deck/node` | ^6.0.0 | Alle HID complexiteit, alle modellen, MIT |
| `ws` | ^8.18.0 | Snelste WebSocket server voor Node.js, MIT |
| `typescript` | ^5.8.0 | Type safety, ES2022 target |
| `tsx` | ^4.19.0 | Direct TypeScript uitvoeren tijdens development |
