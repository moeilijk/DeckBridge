# DeckBridge

A drop-in replacement for the Elgato Stream Deck software on Linux. Designed to
be as compatible as possible with existing marketplace plugins — the same
WebSocket protocol, the same manifest format, the same API.

## Status

Early development. Stream Deck XL and Stream Deck + (including dials, touch strip
and dial feedback) work, alongside the plugin runtime, the Electron shell and a
visual profile editor. See [docs/roadmap.md](docs/roadmap.md) for the current
state.

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

## Requirements

- Node.js 20 or 22
- A Stream Deck device is **optional** — only needed for real hardware; the
  virtual Stream Deck + works without one.

The udev rule below is only needed when you use a **physical** Stream Deck on
Linux — not for purely virtual testing.

### udev rule (physical hardware on Linux only)

```bash
echo 'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0fd9", TAG+="uaccess"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0fd9", TAG+="uaccess"' | sudo tee /etc/udev/rules.d/70-streamdeck.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Then reconnect the device.

## Running

```bash
npm install
npm run dev
```

For the desktop app:

```bash
npm run dev:electron
```

On startup DeckBridge prints a local dashboard URL, for example:

```text
Dashboard: http://127.0.0.1:34075/dashboard?wsPort=34075
```

DeckBridge uses fixed local ports by default: `34075` for the dashboard and the
plugin WebSocket. Use `DECKBRIDGE_PI_PORT` and `DECKBRIDGE_WS_PORT` to change
them explicitly. If a port is taken, DeckBridge stops with an error instead of
switching to a random port.

In the dashboard you can drag actions from the action library onto Stream Deck
tiles, remove tiles, and open the Property Inspector for a tile. Configured
tiles show the same image live that was sent to the key on the device.

Dashboard interaction:

- Drag an action from the action library onto an empty or existing tile to
  assign it.
- Drag an existing tile onto another tile to swap them, or onto an empty spot to
  move it.
- Click a configured tile to open the Property Inspector.
- Right-click a tile for a menu with a remove option.
- Install plugins via Preferences > Plugins by choosing or dropping a
  `.streamDeckPlugin` or `.zip`. A local path to a `.streamDeckPlugin`, `.zip`
  or `.sdPlugin` folder also works.
- Remove plugins via Preferences > Plugins. DeckBridge asks for confirmation
  first; tiles that reference that plugin are removed from the profile.

The Electron shell starts the same daemon as a child process and loads this
local UI in a desktop window. See [docs/electron.md](docs/electron.md).

Profiles are stored by default in `~/.config/DeckBridge/profiles/default.json`.
Use `DECKBRIDGE_PROFILE=<name>` to use a separate profile file `<name>.json`,
for example for demo or test profiles without polluting the real default
profile.

## Device profiles

DeckBridge offers a virtual Stream Deck + profile by default alongside real
Stream Deck hardware. Connected real Stream Decks stay available; you can switch
between them via the device selector at the bottom of the dashboard.

```bash
DECKBRIDGE_DEVICE_PROFILE=streamdeck-plus npm run dev
```

That variable is only needed if you want the Stream Deck + as the initial
selection. Without it, real hardware stays the first selection when present.

Available profiles:

- `streamdeck-xl` — Stream Deck XL, type `2`, 8 x 4 keys
- `streamdeck-plus` — Stream Deck +, type `7`, 4 x 2 keys and 4 dials

Use `DECKBRIDGE_DEVICE_PROFILE=hardware` to use real hardware only.

## Plugin compatibility

DeckBridge implements the official Elgato Stream Deck WebSocket SDK protocol.

**Works:** Open-source plugins, older archived plugins, cross-platform Node.js
plugins.

**Does not work:** DRM-protected marketplace plugins (require Elgato's key
infrastructure — the same limitation as OpenDeck).

Plugins are installed by default in `~/.config/DeckBridge/plugins/`.

## Architecture

See [docs/architecture.md](docs/architecture.md) for the full architecture
description.

## Roadmap

See [docs/roadmap.md](docs/roadmap.md) for the current roadmap and
[docs/planning.md](docs/planning.md) for the detailed backlog and ordering.

## Reused libraries

- [`@elgato-stream-deck/node`](https://github.com/Julusian/node-elgato-stream-deck) — HID abstraction (MIT, Julusian)
- [`ws`](https://github.com/websockets/ws) — WebSocket server (MIT)

## License

MIT
