# DeckBridge — Roadmap

Deze roadmap is de korte statuslijst. Gebruik [planning.md](planning.md) voor de
uitgewerkte backlog, prioriteiten en acceptatiecriteria.

## Huidige status

DeckBridge heeft nu een werkende core daemon, Electron shell, lokale dashboard UI
en eerste Stream Deck-achtige profiel editor.

Werkend:

- Stream Deck XL detectie en HID button events.
- `setImage` en `setTitle` rendering naar fysieke knoppen.
- Plugin WebSocket server met UUID-routing.
- Plugin manifest parsing en action library.
- Node.js plugins starten.
- `.exe` plugins starten via Wine.
- LHM plugin basisflow met Property Inspector, settings en live readings.
- Property Inspector HTML serveren via lokale HTTP server.
- Property Inspector bootstrap injectie voor browser/Electron gebruik.
- `getSettings`, `setSettings`, `getGlobalSettings`, `setGlobalSettings`.
- `openUrl` via systeembrowser.
- Electron desktopvenster rond de lokale dashboard UI.
- Visuele profiel editor:
  - acties naar tegels slepen;
  - tegels verwijderen via contextmenu;
  - klik op tegel opent Property Inspector;
  - tegels onderling wisselen of verplaatsen;
  - zwevende tegel-preview tijdens slepen;
  - live preview van dezelfde afbeelding die naar het apparaat gaat.

## Prioriteit 1 — Stabiliseren

Doel: de huidige functionaliteit betrouwbaar genoeg maken om dagelijks te
gebruiken.

- [x] Schone standaardprofielen: geen 32 testtegels als default.
- [x] Test/profiel seed data scheiden van echte gebruikerprofielen.
- [x] Profielmutatie-tests: assign, clear, move, swap.
- [ ] UI-fouten zichtbaar tonen in plaats van alleen console/log.
- [ ] Laatste dashboard URL en daemon status duidelijk tonen in Electron.
- [ ] Roadmap en faseplannen blijven synchroniseren met werkelijke status.

## Prioriteit 2 — Profiel editor uitbreiden

Doel: de editor dichter bij Stream Deck software brengen.

- [ ] Rechtsklik-menu: `Copy`.
- [ ] Rechtsklik-menu: `Paste`.
- [ ] Rechtsklik-menu: `Duplicate`.
- [ ] Rechtsklik-menu: `Clear`.
- [ ] Undo/redo voor profielwijzigingen.
- [ ] Insert/shift-drag: slepen tussen tegels schuift de rest op.
- [ ] Meerdere pages/profielen beheren in de UI.
- [ ] Folders: tegel opent sub-grid.
- [ ] Default action icon naar apparaat renderen voor acties die zelf geen image
  sturen.

## Prioriteit 3 — Plugin compatibiliteit

Doel: meer bestaande Stream Deck plugins zonder aanpassingen laten werken.

- [ ] `switchToProfile` volledig testen en afronden.
- [ ] `showAlert` en `showOk` visueel correct renderen.
- [ ] `logMessage` naar plugin/core logbestand.
- [ ] `applicationDidLaunch` en `applicationDidTerminate` via Linux process
  monitoring.
- [ ] `systemDidWakeUp`.
- [ ] `deviceDidConnect` en `deviceDidDisconnect`.
- [ ] Per-plugin Wine prefix in plaats van globale Wine omgeving.
- [ ] Plugin resource paths en icon fallback robuuster maken.

## Prioriteit 4 — Desktop app

Doel: DeckBridge als normale desktop-app gebruiken.

- [ ] System tray icoon.
- [ ] Autostart bij login.
- [ ] Setup wizard voor udev-regels.
- [ ] Packaging met `electron-builder` of vergelijkbaar.
- [ ] Daemon als systemd user service kunnen draaien.
- [ ] Electron alleen als UI kunnen openen tegen een bestaande daemon.

## Prioriteit 5 — Installatie en ecosysteem

Doel: plugins en apparaten makkelijker beheren.

- [ ] Plugin installatie via drag-and-drop van `.streamDeckPlugin` bestanden.
- [ ] Plugin verwijderen/uitschakelen vanuit UI.
- [ ] Multi-device ondersteuning voor meerdere Stream Decks tegelijk.
- [ ] Profiel export/import.
- [ ] Backups van profielwijzigingen.
- [ ] Open-source plugin browser.

## Later

- [ ] `setFeedback` en `setFeedbackLayout` voor Stream Deck +.
- [ ] `dialDown`, `dialUp`, `dialRotate`.
- [ ] `touchTap`.
- [ ] Deep links via `streamdeck://`.
- [ ] `didReceiveResources` en `setResources` voor nieuwere SDK-versies.
- [ ] Chromium remote devtools voor PI debugging.
- [ ] Automatische updates.

## Permanente beperkingen

- DRM-beveiligde marketplace plugins werken niet. Elgato's key-infrastructure is
  niet beschikbaar; dit is dezelfde klasse beperking als bij OpenDeck.
- Het SDK `platform` veld blijft voorlopig `"mac"`, omdat de officiële SDK geen
  `"linux"` waarde kent.
- Wine blijft nodig voor Windows `.exe` plugins.
