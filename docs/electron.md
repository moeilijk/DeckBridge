# DeckBridge — Electron shell

DeckBridge heeft een minimale Electron shell rond de bestaande Node.js daemon.

## Starten

Core-only development:

```bash
npm run dev
```

Desktop UI:

```bash
npm run dev:electron
```

Alias:

```bash
npm run app
```

`dev:electron` voert eerst `npm run build` uit en start daarna:

```bash
env -u ELECTRON_RUN_AS_NODE electron dist/electron/main.js
```

`ELECTRON_RUN_AS_NODE` wordt expliciet verwijderd omdat sommige shells of WSL
sessies die variabele erven. Als die gezet blijft, exposeert Electron zijn
desktop API niet en gedraagt de binary zich als Node.js.

## Procesmodel

Electron draait niet zelf de HID/plugin-core. De Electron main process start de
gebouwde daemon als child process:

```bash
node dist/index.js
```

De daemon blijft eigenaar van:

- Stream Deck HID toegang
- plugin WebSocket server
- plugin child processes
- Property Inspector HTTP server
- profielpersistentie

Electron leest stdout van de daemon. Zodra de daemon dit print:

```text
Dashboard: http://127.0.0.1:<pi-port>/dashboard?wsPort=<ws-port>
```

laadt Electron die URL in de `BrowserWindow`.

## UI gedrag

De dashboard UI gebruikt de lokale HTTP API van de daemon. Acties komen uit de
plugin manifests, tegels komen uit het actieve profiel, en de Property Inspector
wordt in een zijpaneel geopend.

Acties kunnen vanuit de action library naar lege of bestaande tegels worden
gesleept. Bestaande tegels kunnen onderling worden gewisseld door de ene tegel
naar de andere te slepen; slepen naar een lege plek verplaatst de tegel. Een klik
op een geconfigureerde tegel opent direct de Property Inspector. Een
rechtermuisklik op een tegel opent een contextmenu met de verwijderactie.

Voor geconfigureerde tegels toont de UI de laatst naar het apparaat gestuurde
afbeelding. De core bewaart hiervoor per knop een PNG data URL die is gemaakt
uit dezelfde raw RGB buffer die naar de Stream Deck knop gaat. Het dashboard
pollt `/api/state` periodiek zodat plugin-updates zichtbaar worden zonder het
venster te herladen.

## Waarom core apart blijft

Dit houdt de native dependency-grens simpel. `@elgato-stream-deck/node`,
`sharp`, Wine plugins en HID toegang blijven in gewone Node.js draaien. Electron
is voorlopig alleen de desktop shell rond de lokale configuratie-UI.

Dat maakt het ook eenvoudiger om de daemon later als systemd user service te
draaien, terwijl Electron alleen de UI opent.

## Lifecycle

- Electron start de core bij app-start.
- De eerste view toont daemon logs totdat de dashboard-URL beschikbaar is.
- Bij app quit stuurt Electron `SIGINT` naar de core.
- De core gebruikt zijn bestaande shutdownpad om plugins, WebSocket server,
  hardware en PI server te stoppen.

## Huidige beperkingen

- Nog geen packaging (`electron-builder` of vergelijkbaar).
- Nog geen tray/autostart.
- Nog geen IPC API; Electron gebruikt de bestaande lokale HTTP UI.
- Als er al een losse `npm run dev` daemon draait, moet die eerst stoppen omdat
  de Stream Deck hardware maar door een proces tegelijk geopend kan worden.
