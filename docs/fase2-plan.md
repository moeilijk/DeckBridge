# DeckBridge — Fase 2 implementatieplan

> Dit document is bedoeld als handoff voor een nieuwe sessie of agent.
> Lees eerst `docs/roadmap.md` en de memory-bestanden in `.claude/`.

## Huidige staat (einde Fase 1)

De volgende componenten zijn volledig werkend:

| Bestand | Verantwoordelijkheid |
|---|---|
| `src/index.ts` | Main loop, event wiring |
| `src/core/hardware/DeviceManager.ts` | HID via @elgato-stream-deck/node, seriële write queue |
| `src/core/websocket/PluginServer.ts` | WebSocket server, plugin registratie/routing |
| `src/core/plugins/PluginManager.ts` | manifest.json lezen, child_process spawn |
| `src/core/profiles/ProfileManager.ts` | Knop→actie mapping, context UUIDs, JSON persistentie |
| `src/core/render/renderButton.ts` | SVG→sharp→RGB voor setTitle |

Werkende protocol events: `registerPlugin`, `willAppear`, `willDisappear` (impliciet),
`keyDown`, `keyUp`, `setTitle`, `setImage`, `setSettings`, `getSettings`,
`getGlobalSettings`, `logMessage`, `openUrl`.

**Niet geïmplementeerd:** `setGlobalSettings` (persistentie), `sendToPropertyInspector`,
`sendToPlugin` (PI→plugin), Property Inspector HTTP server, Wine .exe support.

---

## Taak 1: Global Settings persistentie

**Bestand:** `src/core/plugins/PluginManager.ts`

Voeg een `Map<string, Record<string, unknown>>` toe voor global settings per plugin-UUID.
Persisteer naar `~/.config/DeckBridge/settings/<pluginId>.json`.

In `src/index.ts`, vervang de twee TODO's:

```typescript
case 'setGlobalSettings': {
  await pluginManager.setGlobalSettings(pluginUUID, payload)
  // stuur didReceiveGlobalSettings terug
  pluginServer.sendToPlugin(pluginUUID, {
    event: 'didReceiveGlobalSettings',
    payload: { settings: payload },
  })
  break
}

case 'getGlobalSettings': {
  const settings = await pluginManager.getGlobalSettings(pluginUUID)
  pluginServer.sendToPlugin(pluginUUID, {
    event: 'didReceiveGlobalSettings',
    payload: { settings },
  })
  break
}
```

---

## Taak 2: Property Inspector HTTP server

**Nieuw bestand:** `src/core/pi/PropertyInspectorServer.ts`

De PI is een HTML pagina die de plugin bundelt. DeckBridge moet hem serveren via HTTP
zodat een browser (of Electron WebView later) hem kan laden.

```typescript
import { createServer } from 'http'
import { createReadStream } from 'fs'
import { join, extname } from 'path'
import { lookup } from 'mime-types'  // npm install mime-types

export class PropertyInspectorServer {
  private port: number = 0

  async start(pluginBaseDir: string): Promise<void> {
    // pluginBaseDir = ~/.config/DeckBridge/plugins/
    // Verzoek: GET /com.moeilijk.lhm/index_pi.html
    // → serveer bestand uit pluginBaseDir/com.moeilijk.lhm.sdPlugin/index_pi.html

    const server = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost`)
      const parts = url.pathname.slice(1).split('/')
      const pluginId = parts[0]           // 'com.moeilijk.lhm'
      const filePath = parts.slice(1).join('/')

      const fullPath = join(pluginBaseDir, `${pluginId}.sdPlugin`, filePath)
      const mimeType = lookup(extname(fullPath)) || 'application/octet-stream'

      res.setHeader('Content-Type', mimeType)
      createReadStream(fullPath)
        .on('error', () => { res.writeHead(404); res.end() })
        .pipe(res)
    })

    await new Promise<void>(resolve => server.listen(0, resolve))
    this.port = (server.address() as { port: number }).port
    console.log(`PI server op poort ${this.port}`)
  }

  getPort(): number { return this.port }
}
```

Registreer in `src/index.ts`:
```typescript
const piServer = new PropertyInspectorServer()
await piServer.start(pluginDir)
```

En geef de poort mee in de `infoJson` die naar plugins wordt gestuurd:
```typescript
// In PluginManager.ts, infoJson opbouwen:
application: {
  language: 'en',
  platform: 'mac',
  platformVersion: '14.0',
  version: '7.3.0',
},
// Voeg toe:
// De PI HTTP poort is NIET standaard in het protocol — plugins openen
// de PI zelf via xdg-open of de host opent een WebView.
```

---

## Taak 3: sendToPropertyInspector / sendToPlugin (PI↔plugin)

**Protocol flow:**
```
Plugin → host: { event: 'sendToPropertyInspector', action, context, payload }
Host → PI:     { event: 'sendToPropertyInspector', action, context, payload }

PI → host:     { event: 'sendToPlugin', action, context, payload }
Host → plugin: { event: 'sendToPlugin', action, context, payload }
```

**Wijzigingen in `src/core/websocket/PluginServer.ts`:**

De PI registreert als `registerPropertyInspector` met een `uuid` (de context van de knop
waarvoor de PI open is). Er kan per context maar één PI actief zijn.

Voeg toe aan de `clients` Map een aparte lookup `piByContext`:
```typescript
private piByContext = new Map<string, PluginClient>()  // context → PI client
```

In `handleRegistration`, als type === `propertyInspector`:
```typescript
this.piByContext.set(msg.uuid, client)  // uuid = context van de knop
```

Voeg methoden toe:
```typescript
sendToPropertyInspector(context: string, payload: Record<string, unknown>): void {
  const pi = this.piByContext.get(context)
  if (pi?.socket.readyState === WebSocket.OPEN) {
    pi.socket.send(JSON.stringify(payload))
  }
}
```

**In `src/index.ts`**, voeg toe aan de `pluginMessage` switch:

```typescript
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
```

En voor berichten VAN de PI (`pluginMessage` met `sendToPlugin`):
```typescript
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
```

**PI registratie event (`pluginRegistered` voor type=propertyInspector):**
Als een PI zich registreert, stuur `didAppear` naar de plugin:
```typescript
// In index.ts pluginRegistered handler, type === 'propertyInspector':
const loc = profileManager.getSlotByContext(piUUID)  // piUUID = context
if (loc) {
  const pluginUUID = pluginManager.getPluginUUID(loc.slot.pluginId)
  if (pluginUUID) {
    pluginServer.sendToPlugin(pluginUUID, {
      event: 'propertyInspectorDidAppear',
      action: loc.slot.actionId,
      context: piUUID,
      device: loc.deviceId,
    })
  }
}
```

---

## Taak 4: Wine .exe plugin support

**In `src/core/plugins/PluginManager.ts`**, de `.exe` spawn is al aanwezig:
```typescript
this.spawnPlugin(manifest.UUID, pluginUUID, pluginDir, 'wine', [exePath, ...args])
```

Wat ontbreekt: geïsoleerde WINEPREFIX per plugin.

```typescript
// In spawnPlugin, vóór spawn:
const winePrefix = join(homedir(), '.config', 'DeckBridge', 'wine', manifest.UUID)
await mkdir(winePrefix, { recursive: true })

const proc = spawn(cmd, args, {
  cwd: pluginDir,
  stdio: 'pipe',
  env: { ...process.env, WINEPREFIX: winePrefix, WINEDEBUG: '-all' },
})
```

---

## Taak 5: lhm-streamdeck testen via Wine + lhm-companion

**NIET cross-compileren naar Linux** — dat breekt Windows .exe compatibiliteit.

De plugin (.exe) draait via Wine. Sensor data komt van **lhm-companion**
(`/home/cvdveer/projects/GitHub/lhm-companion`), een Linux service die `/data.json`
serveert in exact het LHM-formaat. De plugin ondersteunt "remote source profiles" —
configureer hem met `http://localhost:8085` als bron. Geen plugin-aanpassingen nodig.

**Stappen:**
1. lhm-companion installeren:
   ```bash
   cd /home/cvdveer/projects/GitHub/lhm-companion
   sudo make install   # installeert binary + systemd service
   sudo systemctl enable --now lhm-companion
   curl http://localhost:8085/data.json | head -20  # verificatie
   ```
2. lhm-streamdeck.exe symlinken naar plugins dir:
   ```bash
   ln -sf /home/cvdveer/projects/GitHub/lhm-streamdeck/com.moeilijk.lhm.sdPlugin \
     ~/.config/DeckBridge/plugins/
   ```
3. DeckBridge starten en controleren of Wine de plugin spawnt
4. Plugin configureren: voeg source profile toe met URL `http://localhost:8085`
5. Property Inspector openen via `piServer.getUrl()` in een browser

---

## Volgorde van implementatie

1. **Global settings persistentie** — klein, snel gedaan
2. **sendToPropertyInspector / sendToPlugin** — nodig voor alle serieuze plugins
3. **Property Inspector HTTP server** — nodig om PI te openen
4. **Wine support verfijnen** — WINEPREFIX isolatie
5. **lhm-streamdeck Linux build** — separaat traject, raakt ook de plugin zelf

---

## Bekende WSL2 beperkingen (niet oplossen, gewoon weten)

- Interrupt OUT USB transfers werken niet via usbipd → opgelost via usbhid quirk
- @julusian/jpeg-turbo segfault → opgelost door index.js te overschrijven met `{}`
- Device node wisselt na re-attach (hidraw0 → hidraw1) → profiel handmatig bijwerken
  (Fase 3: auto-detect op basis van serienummer)
- usbhid quirk overleeft geen reboot → toevoegen aan `/etc/modprobe.d/streamdeck.conf`
