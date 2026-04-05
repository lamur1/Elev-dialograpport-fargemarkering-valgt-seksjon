# Utviklingshistorikk – Canvas Dialograpport Seksjonsmarkering

## Hva utvidelsen gjør (fungerer)
- Henter alle seksjoner i kurset via Canvas API
- Auto-detekterer hvilken seksjon læreren tilhører via `/api/v1/users/self`
- Markerer elevene i lærerens seksjon med valgfri bakgrunnsfarge i tabellen
- Fargen "henger på" selv etter manuell sortering (MutationObserver + klikklyttere)
- Popup med fargepalette (duse + knapt synlige farger), seksjonsvelger og av/på
- Innstillinger lagres lokalt (`chrome.storage.local`)
- Ikonet: snakkeboble med farget stripe i Canvas-blå

---

## Auto-sortering – problemet som gjenstår

### Ønsket oppførsel
Ved sidelast skal tabellen automatisk sorteres etter kolonnen
**«Ikke vurderte oppgaver»** synkende (flest ventende dager øverst).

### Canvas sin oppførsel
- Siden bruker **jQuery TableSorter** (via jQuery Migrate 3.4.1)
- Ved sidelast er tabellen alltid sortert alfabetisk på **«Elev»** (kolonne 0)
- Kolonnen «Ikke vurderte oppgaver» har `data-column="4"` og starter med
  klassen `tablesorter-headerUnSorted`
- **To manuelle klikk** på kolonneoverskriften gir ønsket synkende rekkefølge

### Hva vi prøvde

#### 1. Native `.click()` på `<th>` og `<div class="tablesorter-header-inner">`
Klikket ble ignorert fullstendig. TableSorter bruker jQuery-bundne hendelser
og reagerer ikke på native DOM `.click()` fra content script-konteksten.

#### 2. Vente på `tablesorter-header`-klassen før klikk
Forbedret timing, men native klikk virket fortsatt ikke.

#### 3. `jQuery(table).trigger('sorton', [[[4, 1]]])`  
**Rotårsak oppdaget:** Chrome extension content scripts kjører i en
**isolert JavaScript-verden**. De ser DOM-en, men ikke sidens JS-variabler.
`window.jQuery` er `undefined` i content script-konteksten selv om
Canvas har jQuery lastet. Alle direkte jQuery-kall fra content script
er derfor usynlige for TableSorter.

#### 4. Injisert `sorter.js` via `<script src="chrome-extension://...">` (side-kontekst)
Dette løste isolasjonsproblemet. Skriptet kjøres i sidens egen JS-kontekst
og har tilgang til sidens jQuery-instans.

**Resultat:** Sorteringen virker – men bare ett klikk tar effekt.
Tabellen sorteres stigende (1 dag øverst, nullene øverst for elever uten
innleveringer). Andre klikk (som skulle snu til synkende) ser ikke ut til
å registreres av TableSorter.

**Forsøkte variasjoner:**
- `sorton`-APIet med `[[[4, 0]]]` og `[[[4, 1]]]` – begge gir stigende
- To `jq(header).trigger('click')` med 800 ms mellomrom – bare første tar effekt
- To `jq(inner).trigger('click')` med 800 ms mellomrom – samme resultat
- Økt delay til 1500 ms mellom klikkene – samme resultat

### Mulig årsak til at andre klikk ikke virker
MutationObserveren i content scriptet kaller `applyHighlights()` når
TableSorter re-rendrer tabellen etter første klikk. Dette trigger nye
DOM-endringer (bakgrunnsfarger på rader) som muligens forstyrrer
TableSorter sin interne tilstandsmaskin før andre klikk ankommer.
`isSorting`-flagget er ment å blokkere dette, men timingen er ikke perfekt.

### Observert symptom (etter injisert sorter.js med fast 1500 ms delay)
«Rett visning ett lite sekund, så går det over i noe annet.»

**Rotårsak:** `script.onload` fyrer av med én gang sorter.js sin IIFE starter
kjøring – altså *før* setTimeout(1500 ms) inne i sorter.js er ferdig.
Dette betyr at `sortDone = true` og `isSorting = false` ble satt for tidlig,
og `observeForChanges()` startet mens klikk 2 ennå ikke hadde skjedd.
MutationObserveren fanget opp DOM-endringene fra klikk 2 og kalte
`applyHighlights()` – noe som muligens fikk TableSorter til å re-sortere.

---

## Løsning implementert (Claude Code, 2026-04-05)

### Endring 1 – `sorter.js`: reaktiv klasse-polling + cds-sort-done-event
I stedet for `setTimeout(1500)` for klikk 2:
- Etter klikk 1: poll hvert 100 ms inntil `tablesorter-headerAsc` er satt
- Etter klikk 2: poll hvert 100 ms inntil `tablesorter-headerDesc` er satt
- Dispatch `document.dispatchEvent(new CustomEvent('cds-sort-done'))` når ferdig
- Max 40 polls (4 sek) per steg, signal done uansett ved timeout

### Endring 2 – `content.js`: event-basert ferdig-signal
- `injectPageSort` lytter på `cds-sort-done` (ikke `script.onload`) for å vite
  når sorteringen er virkelig ferdig
- Callback (→ `applyHighlights` + `observeForChanges`) kjøres først da
- `isSorting = true` er bevart helt frem til eventet ankommer

### Endring 3 – `content.js`: koble fra MutationObserver under sortering
- `mutationObserver`-referansen lagres på modul-nivå
- `triggerSort()` kaller `mutationObserver.disconnect()` før injeksjon
- Observer startes på nytt av `observeForChanges()` i callback etter sort

---

### Neste steg å prøve i terminal / Claude Code
```javascript
// Alternativ 1: Hold isSorting=true lenger (2500 ms) så Observer
// ikke forstyrrer mellom klikk 1 og klikk 2

// Alternativ 2: I sorter.js – sjekk klassen etter klikk 1 og
// klikk igjen først når tablesorter-headerAsc er bekreftet:
setTimeout(function() {
  if (header.classList.contains('tablesorter-headerAsc')) {
    jq(header).trigger('click');
  }
}, 1500);

// Alternativ 3: Bruk TableSorter sin interne config direkte:
var ts = jq(table)[0].config;
ts.sortList = [[4, 1]];
jq(table).trigger('updateAll');

// Alternativ 4: Deaktiver MutationObserver midlertidig under sortering
```

---

## Filstruktur
```
dialograpport-seksjon/
├── manifest.json        – MV3, tillatelser: storage, tabs
├── content.js           – Hoved-logikk: API-kall, fargemarkering, sortering
├── sorter.js            – Kjøres i sidens JS-kontekst (jQuery-tilgang)
├── popup.html           – UI: seksjonskort, fargepalette, sorteringsvalg
├── popup.js             – Popup-logikk, direktemelding til content script
├── HISTORIKK.md         – Denne filen
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Installasjon (påminnelse)
1. Pakk ut mappen
2. `chrome://extensions` → Utviklermodus på → Last inn upakket
3. Åpne Dialograpport-siden i Canvas
4. Klikk utvidelsesikonet og velg seksjon (hentes automatisk)
