# DeckBridge

Drop-in vervanging voor de Elgato Stream Deck software op Linux. Zo compatibel mogelijk met bestaande marketplace plugins — hetzelfde WebSocket protocol, zelfde manifest formaat, zelfde API.

## Status

Vroege ontwikkeling. Stream Deck XL en Stream Deck + (inclusief dials, touch
strip en dial-feedback) werken, naast de plugin runtime, Electron shell en een
visuele profiel editor. Zie [docs/roadmap.md](docs/roadmap.md) voor de actuele
status.

## Quick start — test dial support on Windows (WSL2 + VSCode)

DeckBridge ships with a **virtual Stream Deck +** as its default device, so you
can develop and test dial / encoder plugins **without owning the hardware**. On
Windows the supported way to run it is inside **WSL2**, edited from **VSCode**.
No Stream Deck, no dials and no udev rule are required for virtual testing.

### 1. One-time Windows setup

In an **administrator PowerShell**:

```powershell
wsl --install            # installs WSL2 + Ubuntu (reboot if prompted)
```

Then in **VSCode**, install Microsoft's **WSL** extension and run
`Ctrl+Shift+P` → **WSL: Connect to WSL**. You now have a VSCode window whose
terminal and files live inside Ubuntu.

### 2. Install Node.js (inside the WSL2 terminal)

DeckBridge needs Node.js 20 or 22:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
exec $SHELL
nvm install 22
```

### 3. Deploy, build and start (inside the WSL2 terminal)

```bash
git clone https://github.com/moeilijk/DeckBridge
cd DeckBridge
npm install              # installs deps + builds the native HID layer

npm run dev              # start: daemon + dashboard (tsx, no build step)
```

Prefer a compiled run? Build once, then start the compiled output:

```bash
npm run build            # tsc -> dist/
npm start                # node dist/index.js
```

### 4. Open the dashboard (in your Windows browser)

DeckBridge prints a URL such as:

```text
Dashboard: http://127.0.0.1:34075/dashboard?wsPort=34075
```

WSL2 forwards `localhost` to Windows automatically, so open that exact URL in
your **Windows** browser. You get a virtual Stream Deck + with four dials, a
touch strip and live dial feedback, all driven from the browser:

- **Rotate** a dial with the `-` / `+` buttons beneath it
- **Press** a dial with the **Press** button
- **Tap** the touch strip with the **Touch** button
- Keys and dial feedback render live, exactly as they are sent to the device

> **Using a real Stream Deck over WSL2?** That additionally needs USB
> passthrough (`usbipd-win`) and a HID quirk, and is only required for physical
> hardware — virtual dial testing needs none of it. A connected device shows up
> alongside the virtual one in the device selector at the bottom of the
> dashboard.

## Vereisten

- Node.js 20 of 24
- Een Stream Deck apparaat is **optioneel** — alleen nodig voor echte hardware;
  de virtuele Stream Deck + werkt zonder.

De onderstaande udev-regel is alleen nodig wanneer je een **fysiek** Stream Deck
op Linux gebruikt — niet voor puur virtueel testen.

### udev regel (alleen voor fysieke hardware op Linux)

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
Dashboard: http://127.0.0.1:34075/dashboard?wsPort=37685
```

DeckBridge gebruikt standaard vaste lokale poorten: `34075` voor het dashboard
en `37685` voor de plugin-WebSocket. Gebruik `DECKBRIDGE_PI_PORT` en
`DECKBRIDGE_WS_PORT` om ze expliciet te wijzigen. Als een poort bezet is, stopt
DeckBridge met een fout in plaats van naar een willekeurige poort te wisselen.

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
- Installeer plugins via Preferences > Plugins door een `.streamDeckPlugin` of
  `.zip` te kiezen of te droppen. Een lokaal pad naar een `.streamDeckPlugin`,
  `.zip` of `.sdPlugin` map kan ook.
- Verwijder plugins via Preferences > Plugins. DeckBridge vraagt eerst om
  bevestiging; tegels die naar die plugin verwijzen worden uit het profiel
  verwijderd.

De Electron shell start dezelfde daemon als child process en laadt deze lokale
UI in een desktopvenster. Zie [docs/electron.md](docs/electron.md).

Profielen staan standaard in `~/.config/DeckBridge/profiles/default.json`.
Gebruik `DECKBRIDGE_PROFILE=<naam>` om een apart profielbestand
`<naam>.json` te gebruiken, bijvoorbeeld voor demo- of testprofielen zonder het
echte default-profiel te vervuilen.

## Device-profielen

DeckBridge biedt standaard een virtueel Stream Deck+-profiel aan naast echte
Stream Deck-hardware. Echte aangesloten Stream Decks blijven beschikbaar; in het
dashboard kun je wisselen via de device-keuze onderaan.

```bash
DECKBRIDGE_DEVICE_PROFILE=streamdeck-plus npm run dev
```

Die variabele is alleen nodig als je Stream Deck+ als startselectie wilt. Zonder
variabele blijft echte hardware de eerste selectie wanneer die aanwezig is.

Beschikbare profielen:

- `streamdeck-xl` — Stream Deck XL, type `2`, 8 x 4 keys
- `streamdeck-plus` — Stream Deck +, type `7`, 4 x 2 keys en 4 dials

Gebruik `DECKBRIDGE_DEVICE_PROFILE=hardware` om alleen echte hardware te
gebruiken.

## Plugin Compatibiliteit

DeckBridge implementeert het officiële Elgato Stream Deck WebSocket SDK protocol.

**Werkt:** Open-source plugins, oudere gearchiveerde plugins, cross-platform Node.js plugins.

**Werkt niet:** DRM-beveiligde marketplace plugins (vereist Elgato's key-infrastructure — zelfde beperking als OpenDeck).

Plugins worden standaard geïnstalleerd in `~/.config/DeckBridge/plugins/`.

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
