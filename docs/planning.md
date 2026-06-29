# DeckBridge — Planning

Dit document is bedoeld als werkbacklog. De roadmap blijft de korte
statussamenvatting; dit document houdt bij wat de eerstvolgende werkbare stappen
zijn en wanneer ze klaar zijn.

## Werkvolgorde

### 1. Stabilisatie van huidige editor

Waarom: de dashboard editor werkt nu, maar dit is de basis waar alle volgende
features op leunen.

Taken:

- [x] Schone standaardstart maken zonder 32 testtegels.
- [x] Testprofiel of demo-profiel expliciet los trekken van `default.json` via
  named profiles (`DECKBRIDGE_PROFILE=<naam>`).
- [x] Profielmutaties testen:
  - [x] actie toewijzen aan lege tegel;
  - [x] actie vervangen op bestaande tegel;
  - [x] tegel verwijderen;
  - [x] tegel verplaatsen naar lege plek;
  - [x] twee tegels wisselen;
  - [x] context en settings behouden bij move/swap.
- [ ] UI-fouten zichtbaar maken in de header/status in plaats van alleen console.
- [ ] Bij profielmutaties de fysieke knop en UI-preview consistent houden met
  bredere integratietests.

Klaar wanneer:

- [x] Een nieuw profiel leeg of bewust gekozen demo-data bevat.
- [x] De bovengenoemde profielmutaties reproduceerbaar getest zijn.
- [ ] Een mislukte API-call zichtbaar wordt in de UI.

### 2. Rechtermuisknop workflow

Waarom: copy/paste/duplicate zijn essentieel om veel tegels snel te beheren.

Taken:

- [x] `Copy` in contextmenu.
- [x] `Paste` in contextmenu.
- [x] `Duplicate` in contextmenu (naar eerste lege tegel).
- ~~`Clear` als expliciet menu-item naast remove.~~ (zelfde als Remove, geschrapt)
- [x] Clipboard-state zichtbaar maken in disabled/enabled menu states.
- [x] Beslissen of paste context behoudt of nieuwe context maakt.

Voorlopige beslissing:

- `Copy` bewaart plugin/action/settings.
- `Paste` maakt een nieuwe context.
- `Duplicate` maakt ook een nieuwe context.
- `Move` behoudt context.

Klaar wanneer:

- Gekopieerde LHM reading op een andere tegel werkt zonder het origineel te
  breken.
- Duplicate van een testactie visueel en fysiek rendert.
- Menu-items correct disabled zijn als er geen bron/tegel is.

### 3. Pages en profielen ✓

Waarom: een Stream Deck XL is snel vol; pages/folders zijn nodig voor echt
gebruik.

Taken:

- Profielmodel uitbreiden met pages.
- UI page tabs of page selector toevoegen.
- Actieve page naar hardware renderen.
- Page switch events correct naar plugins sturen.
- `switchToProfile` koppelen aan het profiel/page model.

Open vragen:

- Noemen we dit `profiles`, `pages`, of beide?
- Moet een plugin per actie eigen subprofielen kunnen hebben zoals de Stream
  Deck SDK verwacht?

Klaar wanneer:

- Gebruiker kan wisselen tussen minstens twee pages.
- Hardware toont na page switch de juiste tegels.
- `willAppear` en `willDisappear` blijven correct.

### 4. Folders ✓

Waarom: folders zijn de natuurlijke manier om sub-grids te maken.

Taken:

- [x] Stap 4a: `ProfileManager` folder datamodel en navigatiestack.
- [x] Stap 4b: `index.ts` folder/back systeemacties, `keyDown`, hardware render.
- [x] Stap 4c: Dashboard UI — foldertegel tonen, aanmaken, breadcrumb/back.
- [x] Drag/drop binnen folders.

Klaar wanneer:

- [x] Een foldertegel opent een tweede grid.
- [x] Terug navigeren herstelt de vorige grid.
- [x] Tegels in folders blijven persistent.

### 5. Plugin compatibiliteit

Waarom: de waarde van DeckBridge zit in bestaande plugin support.

Taken:

- [ ] `switchToProfile` afronden.
- [x] `applicationDidLaunch` en `applicationDidTerminate` implementeren.
- [x] `systemDidWakeUp` implementeren.
- [x] `deviceDidConnect` en `deviceDidDisconnect` implementeren.
- [x] `showAlert` en `showOk` visueel correct maken.
- [x] `logMessage` naar bestand.
- [x] Per-plugin Wine prefix.

Handtest checklist (Step 5):

1. Start DeckBridge met `npm run app`.
2. Open een plugin action en trigger `showOk`/`showAlert`; controleer korte overlay op fysieke key.
3. Controleer plugin logfile in `~/.config/DeckBridge/logs/plugins/<plugin-id>.log` na `logMessage`.
4. Zet `ApplicationsToMonitor` in plugin manifest of `DECKBRIDGE_MONITOR_APPS`, start/stop zo'n proces en controleer launch/terminate events in plugin gedrag/logs.
5. Koppel Stream Deck los/aan en bevestig dat plugin correct reageert op connect/disconnect.
6. Test `switchToProfile` voor page-switch paden (huidige fallback gebruikt page index).

Klaar wanneer:

- Minstens twee externe plugins naast LHM zonder codewijziging bruikbaar zijn.
- Plugin logs zijn terug te vinden per plugin.
- Wine plugin state lekt niet onnodig tussen plugins.

### 6. Desktop distributie

Waarom: starten via terminal is geen productervaring.

Taken:

- System tray.
- Autostart bij login.
- Setup wizard voor udev.
- Packaging met Electron builder.
- Optie om Electron te verbinden met bestaande daemon.
- Later: daemon als systemd user service.

Klaar wanneer:

- DeckBridge kan starten na login zonder terminal.
- Gebruiker kan zien of de daemon draait.
- App kan netjes afsluiten en plugins stoppen.

### 7. Named profielen (profielbeheer) — huidige prioriteit

Waarom: sectie 3 leverde pages binnen één profiel, maar geen named profielen.
Gebruikers (dev discord) vragen om wat Elgato "profielen" noemt: meerdere
benoemde tegel-sets die je aanmaakt, hernoemt, wist en wisselt — los van pages en
folders, die bínnen een profiel blijven. De opslaglaag kan dit al
(`ProfileManager.switchProfile`, één bestand per profiel in
`~/.config/DeckBridge/profiles/<naam>.json`), maar er is geen UI en geen
runtime-beheer; wisselen kan nu alleen via de env-var `DECKBRIDGE_PROFILE` of een
plugin die `switchToProfile` stuurt.

Begrippenkader (vastleggen om de sectie-3-verwarring te voorkomen):

- Profiel = één `.json`-bestand; bevat pages en folders.
- Page = grid binnen een profiel (bestaat al).
- Folder = sub-grid binnen een page (bestaat al).

Scope-beslissing: profielen blijven in fase 1 **globaal** (overspannen alle
devices, zoals het huidige model met slots gekeyd op `deviceId|keyIndex`).
Per-device profielen (zoals Elgato) is een latere verfijning — zie open vragen.

#### Testregels (overgenomen uit de lhm-streamdeck dial-ontwikkeling)

Deze regels komen uit `lhm-streamdeck/AGENTS.md` en de DeckBridge-`CLAUDE.md`; ze
golden tijdens de dial-ontwikkeling en gelden net zo hard voor profielwerk:

- **Zichtbare DeckBridge-wijziging → `BUILD relurl-####` ophogen** in dezelfde
  wijziging, plus een DeckBridge-test die dat assert.
- **Test het gerenderde, voor de gebruiker zichtbare resultaat — niet alleen het
  protocol.** Dat `/api/profiles` of een WS-bericht klopt is niet genoeg; de
  terugkerende bugklasse zit in hoe het dashboard de DOM rendert. Draai de echte
  render/patch-functie tegen een DOM (jsdom-recept, zie
  `tests/dialDeckRender.test.ts`) en assert het zichtbare resultaat: na een
  profiel-switch verversen grid, page-tabs én de profiel-selector echt.
- **Dek expliciet de toestanden waar bugs schuilen:** Property Inspector open én
  dicht; in een folder én op page-niveau; leeg én gevuld profiel;
  ontbrekende/`null`-velden.
- **Verplichte liveness-e2e:** met een dial-PI open blijven na een profiel-switch
  de tegels/dials in de tijd updaten (de getoonde beelden veranderen) — vangt
  "scherm bevriest terwijl de plugin doordraait".
- Nieuwe tests draaien in `npm test`.

#### Fase 1 — Profielbeheer in het dashboard (eerst)

`ProfileManager` (backend):

- [ ] `listProfiles()` — namen scannen uit `profileDir` (`*.json`), met markering welk profiel actief is.
- [ ] `getActiveProfileName()` + actieve naam als veld bijhouden.
- [ ] `createProfile(name)` — leeg profielbestand; naamvalidatie via bestaande `normalizeProfileName`; duplicaat weigeren.
- [ ] `renameProfile(old, new)` — bestand hernoemen, actieve verwijzing meeverhuizen.
- [ ] `deleteProfile(name)` — bestand verwijderen; actief profiel én het laatste overgebleven profiel mogen niet weg.
- [ ] Actieve profielkeuze persistent maken (in `device-settings.json` of een nieuwe `profiles-meta.json`), zodat een herstart de keuze onthoudt i.p.v. de env-var.

`index.ts` (wiring):

- [ ] `piServer.setProfileHandlers({ list, create, rename, remove, switch })` + provider.
- [ ] Profiel-switch hergebruikt de bestaande `switchToProfile`-flow: `willDisappear` voor oude slots, `load()`, `syncNavButtons()`, display-state legen, `renderCurrentView(true)`.
- [ ] Actieve page valideren/resetten tegen het nieuwe profiel na switch.

`PropertyInspectorServer` (HTTP routes):

- [ ] `GET /api/profiles` — lijst + actief.
- [ ] `POST /api/profiles` (create), `PATCH /api/profiles/:name` (rename), `DELETE /api/profiles/:name`.
- [ ] `POST /api/profile/switch`.

Dashboard UI:

- [ ] Profiel-selector naast de device-keuze onderaan (dropdown).
- [ ] "+ Nieuw profiel", inline hernoemen, verwijderen met bevestiging.
- [ ] Na switch grid, page-tabs en feedback live verversen (geen F5).

Randgevallen:

- [ ] Actief/laatste profiel niet verwijderbaar; UI in disabled state.
- [ ] Switch terwijl je in een folder zit → eerst folders verlaten.
- [ ] Verhouding tot `DECKBRIDGE_PROFILE`: env zet alleen het start-profiel; een UI-switch overschrijft en persisteert.
- [ ] Naamcollisie/ongeldige tekens als zichtbare UI-fout tonen.

Klaar wanneer:

- [ ] Gebruiker maakt, hernoemt, wist en wisselt profielen volledig vanuit het dashboard.
- [ ] Het gekozen profiel overleeft een herstart zonder env-var.
- [ ] Hardware/preview toont na switch de juiste tegels; `willAppear`/`willDisappear` blijven correct.
- [ ] `ProfileManager` profiel-CRUD heeft tests, in lijn met de bestaande mutatie-tests.

#### Fase 2 — Per-applicatie profielen (later)

- [ ] Profiel koppelen aan een applicatie-identifier; mapping in profiles-meta.
- [ ] Auto-switch via de bestaande app-monitor (`applicationDidLaunch`/`applicationDidTerminate`).
- [ ] Beperking documenteren: de monitor detecteert proces-start/stop via `ps`, geen window-focus; echte focus-detectie op Linux/Wayland is een apart traject.

#### Fase 3 — Plugin-gebundelde profielen (later)

- [ ] Manifest-veld `Profiles` in `PluginManager` parsen (`Name`, `DeviceType`, `Readonly`, `DontAutoSwitchWhenInstalled`).
- [ ] `switchToProfile` naar een niet-bestaand maar door een plugin gebundeld profiel → uitrollen.
- [ ] Onderzoek: Elgato `.streamDeckProfile`-formaat naar DeckBridge-profielformaat mappen (niet triviaal).

Open vragen:

- [ ] Per-device profielen (Elgato bindt een profiel aan één device-model) versus het huidige globale model. Migratiepad?
- [ ] Profiel export/import (roadmap prio 5) samenvoegen met dit werk?

## Technische verbeteringen

- `/api/state` polling vervangen door push via WebSocket of SSE.
- API endpoints opdelen per verantwoordelijkheid als `PropertyInspectorServer`
  te groot blijft.
- Dashboard HTML/CSS/JS uit TypeScript template halen zodra de UI verder groeit.
- Playwright of vergelijkbare browser-test tooling toevoegen.
- Profielbestanden migratieversies geven.
- Profielbackups maken voor mutaties.

## Beslissingen

- De core daemon blijft eigenaar van HID, plugins, Wine en profielpersistentie.
- Electron is voorlopig een shell rond de lokale dashboard UI.
- De UI-preview gebruikt dezelfde raw RGB render-output als de fysieke knop.
- Actie toewijzen maakt een nieuwe context.
- Tegel move/swap behoudt context en settings.
- Paste/duplicate moeten waarschijnlijk een nieuwe context maken.

## Eerstvolgende aanbevolen commits

1. `docs: sync roadmap and planning`
2. `fix: start with clean default profile`
3. `test: cover profile mutations`
4. `feat: add tile clipboard actions`
5. `feat: add profile pages`
