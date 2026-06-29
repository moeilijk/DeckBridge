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
- [x] UI-fouten zichtbaar tonen in plaats van alleen console/log (error-banner met auto-dismiss en X-knop, showError() helper, alle deckStatus-foutassignments vervangen).
- [x] Laatste dashboard URL en daemon status duidelijk tonen in Electron (title "DeckBridge — connected", tray tooltip met URL).
- [x] Roadmap en faseplannen blijven synchroniseren met werkelijke status.

## Prioriteit 2 — Profiel editor uitbreiden

Doel: de editor dichter bij Stream Deck software brengen.

- [x] Undo/redo voor profielwijzigingen (twee-stack model in ProfileManager, max 50 stappen, Ctrl+Z/Y en ⟲⟳ knoppen in dashboard, /api/profile/undo+redo).
- [ ] Insert/shift-drag: slepen tussen tegels schuift de rest op.
- [x] Meerdere pages beheren in de UI (page tabs, Insert Page After, Remove Page).
  Let op: dit dekte alleen **pages**, geen named profielen.
- [ ] **Named profielen (profielbeheer) — huidige focus:** meerdere benoemde
  profielen aanmaken, hernoemen, verwijderen en wisselen vanuit het dashboard,
  los van pages/folders. Uitgewerkt in [planning.md](planning.md) sectie 7.
- [x] Folders: tegel opent sub-grid (Create Folder, enter/leave folder navigatie, breadcrumb bar).
- [x] Rechtsklik-menu: `Copy`.
- [x] Rechtsklik-menu: `Paste`.
- [x] Rechtsklik-menu: `Duplicate`.
- [x] Rechtsklik-menu: `Clear` (Remove Tile).
- [x] Default action icon naar apparaat renderen voor acties die zelf geen image
  sturen.

## Prioriteit 3 — Plugin compatibiliteit

Doel: meer bestaande Stream Deck plugins zonder aanpassingen laten werken.

- [x] `switchToProfile` volledig testen en afronden (payload.profile laadt named profile, payload.page wisselt daarna de pagina).
- [x] `showAlert` en `showOk` visueel correct renderen.
- [x] `logMessage` naar plugin/core logbestand.
- [x] `applicationDidLaunch` en `applicationDidTerminate` via Linux process
  monitoring.
- [x] `systemDidWakeUp`.
- [x] `deviceDidConnect` en `deviceDidDisconnect`.
- [x] Per-plugin Wine prefix in plaats van globale Wine omgeving.
- [x] Plugin resource paths en icon fallback robuuster maken (getIconFilePath met .png/.@2x.png/bare fallback, renderDefaultIcon).

## Prioriteit 4 — Desktop app

Doel: DeckBridge als normale desktop-app gebruiken.

- [x] System tray icoon (SVG icon, Show Dashboard / Copy URL / Quit menu, click to show/hide).
- [x] Autostart bij login (tray "Start at Login" checkbox via app.setLoginItemSettings).
- [ ] Setup wizard voor udev-regels.
- [ ] Packaging met `electron-builder` of vergelijkbaar.
- [ ] Daemon als systemd user service kunnen draaien.
- [ ] Electron alleen als UI kunnen openen tegen een bestaande daemon.

## Prioriteit 5 — Installatie en ecosysteem

Doel: plugins en apparaten makkelijker beheren.

- [x] Plugin installatie via file picker/dropzone voor `.streamDeckPlugin` en
  `.zip` in Preferences > Plugins, plus pad fallback voor `.streamDeckPlugin`,
  `.zip` of `.sdPlugin`.
- [x] Plugin verwijderen vanuit Preferences > Plugins met bevestiging.
- [ ] Plugins tijdelijk uitschakelen zonder verwijderen.
- [ ] Multi-device ondersteuning voor meerdere Stream Decks tegelijk.
- [ ] Profiel export/import.
- [ ] Backups van profielwijzigingen.
- [ ] Open-source plugin browser.

## Later

- [x] `setFeedback` en `setFeedbackLayout` voor Stream Deck + dashboard-emulatie.
- [x] `dialDown`, `dialUp`, `dialRotate` voor virtuele Stream Deck + dials.
- [x] `touchTap` voor virtuele Stream Deck + dials.
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
