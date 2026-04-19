# DeckBridge — Roadmap

## Fase 1 — Hardware & Knoppen (huidige focus)

Doel: Stream Deck XL detecteren, knoppen werken, basis plugin communicatie.

- [x] DeviceManager: detecteer Stream Deck XL via `@elgato-stream-deck/node`
- [x] DeviceManager: verwerk button keyDown / keyUp events
- [x] DeviceManager: stuur afbeelding naar specifieke knop (setImage)
- [x] DeviceManager: helderheid instellen
- [x] PluginServer: WebSocket server opstarten op dynamische poort
- [x] PluginServer: plugin registratie via `registerPlugin` event
- [x] PluginServer: basis event routing op UUID
- [x] PluginServer: `setTitle`, `setImage`, `showAlert`, `showOk` verwerken
- [x] PluginServer: `keyDown` / `keyUp` doorsturen naar juiste plugin
- [x] PluginManager: `manifest.json` lezen en parsen
- [x] PluginManager: Node.js plugins spawnen met de 4 CLI argumenten
- [x] udev setup script voor Linux hardware toegang
- [x] Handmatige test met een eenvoudige open-source plugin

## Fase 2 — Plugin Ecosystem

Doel: De meeste SDK-compatibele plugins draaien zonder aanpassingen.

- [x] Property Inspector: HTML serveren via lokale HTTP server
- [x] Property Inspector: `connectElgatoStreamDeckSocket` injectie in PI webview
- [ ] `getSettings` / `setSettings` / `getGlobalSettings` / `setGlobalSettings`
- [ ] `switchToProfile` — ProfileManager implementatie
- [ ] `applicationDidLaunch` / `Terminate` via `/proc` polling op Linux
- [ ] `systemDidWakeUp` event
- [ ] `openUrl` — systeembrowser openen
- [ ] `logMessage` — plugin logging naar bestand
- [ ] .exe plugins via Wine (geïsoleerde WINEPREFIX per plugin)
- [ ] Multi-device ondersteuning (meerdere Stream Decks tegelijk)
- [ ] `deviceDidConnect` / `Disconnect` events

## Fase 3 — UI & Gebruiksvriendelijkheid

Doel: Configuratie UI zodat gebruikers zonder terminal kunnen werken.

- [x] Electron shell met desktopvenster
- [ ] System tray icoon
- [x] Lokale web-gebaseerde configuratie UI via DeckBridge daemon
- [ ] Web-gebaseerde configuratie UI (Svelte)
- [ ] Plugin installatie via drag-and-drop van .streamDeckPlugin bestanden
- [x] Visuele profiel editor (acties naar knoppen slepen/toewijzen/verwijderen)
- [x] Apparaat preview (live weergave van knopindeling)
- [ ] Automatische udev installatie via setup wizard
- [ ] Autostart bij login (systemd user service of XDG autostart)

## Fase 4 — Geavanceerd

- [ ] `setFeedback` / `setFeedbackLayout` voor Stream Deck + (encoders + touchscreen)
- [ ] `dialDown` / `dialUp` / `dialRotate` events (Stream Deck +)
- [ ] `touchTap` events (Stream Deck +)
- [ ] Deep links (`streamdeck://` protocol registratie)
- [ ] `didReceiveResources` / `setResources` (SDK v7.1+)
- [ ] Chromium remote devtools voor PI debugging (poort 23654)
- [ ] Plugin marketplace browser (open-source plugins)
- [ ] Automatische updates

## Bekende Beperkingen (permanent)

- **DRM-beveiligde marketplace plugins werken niet** — Elgato's key-infrastructure is vereist. Dit is dezelfde beperking als OpenDeck.
- **`platform` field is altijd `"mac"`** — officiële SDK kent geen `"linux"`.
- **Wine vereist voor .exe plugins** — geen Windows-native binaries op Linux zonder Wine.
