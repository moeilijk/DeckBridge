# DeckBridge — Research Bevindingen

## Doel

Drop-in vervanging voor de officiële Elgato Stream Deck software op Linux.
Zo compatibel mogelijk met bestaande marketplace plugins. Begint met Stream Deck XL ondersteuning en knopfunctionaliteit.

---

## 1. Plugin Protocol — WebSocket

De officiële software start elke plugin als een kindproces en geeft vier CLI-argumenten mee:

| Argument | Beschrijving |
|---|---|
| `-port` | TCP-poort van de WebSocket server |
| `-pluginUUID` | Unieke identifier voor deze plugin-instantie |
| `-registerEvent` | `"registerPlugin"` of `"registerPropertyInspector"` |
| `-info` | JSON-string met app/device/plugin metadata |

Direct na verbinding stuurt de plugin:
```json
{ "event": "<registerEvent>", "uuid": "<pluginUUID>" }
```

**Belangrijk:** Er is maar één WebSocket server voor alle plugins. Routing gaat op basis van UUID.

### `-info` JSON structuur

```json
{
  "application": {
    "font": "...",
    "language": "en",
    "platform": "mac",
    "platformVersion": "...",
    "version": "7.3.0"
  },
  "devices": [
    {
      "id": "<device-id>",
      "name": "Stream Deck XL",
      "size": { "columns": 8, "rows": 4 },
      "type": 2
    }
  ],
  "plugin": {
    "uuid": "com.example.plugin",
    "version": "1.0.0"
  }
}
```

**Platform field:** Gebruik altijd `"mac"` — nooit `"linux"` (bestaat niet in de officiële SDK). Veel plugins gebruiken Mac als cross-platform baseline.

### Events die de host naar plugins stuurt

| Event | Trigger |
|---|---|
| `willAppear` / `willDisappear` | Actie geplaatst/verwijderd |
| `keyDown` / `keyUp` | Knopdruk / loslaten |
| `didReceiveSettings` | Na `getSettings` of settings wijziging |
| `didReceiveGlobalSettings` | Na `getGlobalSettings` |
| `propertyInspectorDidAppear` / `DidDisappear` | PI geopend/gesloten |
| `titleParametersDidChange` | Gebruiker wijzigt titelstijl |
| `deviceDidConnect` / `Disconnect` | Hardware events |
| `applicationDidLaunch` / `Terminate` | Gemonitorde applicaties |
| `systemDidWakeUp` | Computer wakker na slaapstand |

### Commando's die plugins naar de host sturen

| Commando | Effect |
|---|---|
| `setTitle` | Tekst op knop instellen |
| `setImage` | Afbeelding op knop (base64 PNG/JPEG/SVG) |
| `setState` | Wissel naar andere action state |
| `getSettings` / `setSettings` | Per-actie persistente instellingen |
| `getGlobalSettings` / `setGlobalSettings` | Plugin-brede instellingen |
| `sendToPropertyInspector` | Data naar PI webview sturen |
| `openUrl` | URL openen in systeembrowser |
| `showAlert` | Rode X flash op knop |
| `showOk` | Groene vinkje flash op knop |
| `switchToProfile` | Laad een gebundeld profiel |
| `logMessage` | Schrijf naar plugin logbestand |

### Property Inspector (PI)

- HTML-bestand in de plugin bundle
- Geladen in een Chromium webview door de host
- Na DOM load roept de host aan: `window.connectElgatoStreamDeckSocket(port, uuid, event, info, actionInfo)`
- PI verbindt ook via WebSocket op dezelfde poort
- Debugging via Chromium remote devtools op poort 23654

---

## 2. Hardware — USB/HID

**Vendor ID (VID):** `0x0FD9` (alle Elgato apparaten)

### Product IDs van relevante modellen

| Model | PID |
|---|---|
| Stream Deck Original | `0x0060` |
| Stream Deck Mini | `0x0063` |
| Stream Deck XL | `0x006C` |
| Stream Deck MK.2 | `0x0080` |
| Stream Deck + (Plus) | `0x0084` |
| Stream Deck Neo | `0x009A` |
| Stream Deck Pedal | `0x0086` |
| Stream Deck Mini MK.2 | `0x0090` |

### HID Protocol (XL en nieuwere modellen)

- Input Report `0x01`: Knopstatus bitmap — één bit per knop
- Output: JPEG afbeeldingen in chunks van 1024 bytes met header
- Feature Report `0x03`: Serienummer opvragen
- Feature Report `0x05`: Helderheid instellen (0–100)
- Feature Report `0x0B`: Apparaat resetten
- Afbeeldingen: 96×96 pixels (XL), JPEG formaat, 180° geroteerd voor verzending

### Linux udev regel (vereist voor non-root toegang)

```
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0fd9", TAG+="uaccess"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0fd9", TAG+="uaccess"
```

Opslaan als `/etc/udev/rules.d/70-streamdeck.rules`
Herladen: `udevadm control --reload-rules && udevadm trigger`

DeckBridge moet een setup-script leveren dat deze regel automatisch installeert.

---

## 3. Plugin Compatibiliteit

### Twee plugin types

**Type 1 — Executable:** `CodePath` wijst naar een compiled binary (.exe, native binary).
Op Linux: .exe plugins vereisen Wine.

**Type 2 — Node.js:** `manifest.json` heeft een `"Nodejs": { "Version": "20" | "24" }` blok.
`CodePath` wijst naar een `.js` bestand.
Host start: `node bin/plugin.js -port P -pluginUUID U -registerEvent registerPlugin -info <JSON>`

### DRM — Harde beperking

Elgato heeft DRM toegevoegd aan marketplace plugins (versneld vanaf April 2024).
DRM-beveiligde plugins werken **niet** op DeckBridge of welke third-party host dan ook — Elgato's key-infrastructure is vereist.

Plugins die wél werken:
- Open-source plugins
- Oudere gearchiveerde plugins (pre-DRM)
- Cross-platform plugins met `CodePathMac`

---

## 4. Bestaande Projecten & Herbruikbare Libraries

### Directe concurrenten / inspiratie

| Project | Stack | Plugin compat | Status |
|---|---|---|---|
| **OpenDeck** (nekename) | Rust + Tauri + Svelte | Elgato SDK (geen DRM) | Actief, Flathub |
| **streamdeck-linux-gui** | Python + Qt | Geen (alleen direct HID) | Maintenance only |
| **StreamController** | Python + GTK4 | Eigen plugin store | Actief beta |
| **Bitfocus Companion** | Node.js | Ander paradigma (broadcast) | Actief, ander doel |

### Herbruikbare libraries (MIT licentie)

| Library | Doel | Licentie |
|---|---|---|
| **`@elgato-stream-deck/node`** (Julusian) | HID voor alle modellen, image encoding, button events | MIT ✓ |
| **`node-hid`** | Low-level USB/HID op Linux (hidraw) | MIT ✓ |
| **`ws`** | WebSocket server — plugin protocol | MIT ✓ |
| **`sharp`** | Snelle image resizing/encoding | Apache 2.0 ✓ |

**`@elgato-stream-deck/node`** handelt alle hardware complexiteit af: alle modellen inclusief XL, image encoding, button events, brightness. Dit is het fundament voor DeckBridge hardware-laag.

---

## 5. Officiële Stream Deck Software Internals

- **Electron-based** (bevestigd via Chromium versie in SDK changelog)
- **Stream Deck 7.3:** Node.js 20.20.0 of 24.13.1, Chromium 130
- Plugins draaien als **losse OS processen** (niet in Electron renderer)
- Plugin directory op Windows: `%APPDATA%\Elgato\StreamDeck\Plugins\<uuid>.sdPlugin\`

---

## 6. Waarom niet Tauri (zoals OpenDeck)?

- Tauri gebruikt system WebKitGTK op Linux — plugins zijn getest met Chromium, compatibility gaps zijn reëel
- Node.js plugins moeten extern gespawnd worden (Tauri bundelt geen Node.js)
- OpenDeck doet dit al in Rust — DeckBridge zou OpenDeck opnieuw bouwen
- Electron bundelt exact de Chromium+Node.js versie die plugins verwachten
