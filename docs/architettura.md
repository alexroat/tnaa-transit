# Architettura

## In breve

L'app è fatta solo di file statici. Una volta al giorno uno script trasforma i GTFS in un unico file compatto; il browser lo combina con i ritardi live di BusOne e calcola da solo dove si trova ogni mezzo.

```mermaid
flowchart LR
  subgraph BusOne
    G[GTFS Trentino Trasporti e Trenitalia]
    R[TripUpdates JSON]
  end
  G --> B[scripts/build_data.py]
  B --> N[app/data/net.json]
  N --> S[schedule.js: orari e posizioni]
  R -->|ogni 30 s| P[rt.js: ritardi]
  S --> M[main.js: mappa e pannello]
  P --> M
  W[sw.js] -. cache .- N
```

## Componenti

| File | Ruolo |
|---|---|
| `scripts/build_data.py` | Scarica, filtra, semplifica e compatta i GTFS |
| `app/data/net.json` | Rete completa: 7,3 MB, circa 1,1 MB compressi |
| `app/js/schedule.js` | Calendario, corse attive, posizione lungo il percorso. Logica pura |
| `app/js/rt.js` | Lettura dei TripUpdates e calcolo dei ritardi. Logica pura |
| `app/js/main.js` | Mappa MapLibre, pannello, aggiornamenti periodici |
| `app/sw.js` | Cache per l'uso offline |
| `app/come-funziona.html` | Spiegazione pubblica di stime e limiti |
| `tests/logic.test.mjs` | Test della logica pura |
| `scripts/check_live.mjs` | Verifica sui feed reali |

## Generazione di `net.json`

1. Scarica i due GTFS da BusOne in `.cache/`.
2. Tiene tutto Trentino Trasporti, e di Trenitalia solo le corse con almeno una fermata nel rettangolo delle ferrovie trentine (`RAIL_AREA`).
3. Unisce le piattaforme nella loro stazione.
4. Semplifica i percorsi con Douglas-Peucker a 8 m.
5. Proietta ogni fermata sul percorso, solo in avanti, per non sbagliare passaggio sulle linee ad anello.
6. Deduplica sequenze di fermate e tempi, così 7.093 corse pesano poco.

Le corse senza percorso (il 3% circa) vengono disegnate in linea retta fra le fermate. Gli orari mancanti vengono interpolati.

Gli ID delle corse live coincidono con quelli del GTFS di BusOne. Per questo gli orari vanno presi da BusOne e non dall'operatore.

## Calcolo della posizione

Il ritardo attuale è il campo `delay` della corsa, che BusOne fornisce per i bus. Per i treni, che non lo hanno, è il ritardo dell'ultimo evento già avvenuto, o in mancanza la prima previsione.

Sui bus i valori delle fermate già superate non vanno usati: BusOne le riporta con un orario schiacciato su "adesso", da cui risulterebbero ritardi finti anche oltre un'ora. Per questo si considerano solo le fermate ancora da raggiungere.

Il mezzo viene poi collocato all'orario `adesso − ritardo`: sosta fra arrivo e partenza e avanza in modo lineare fra due fermate.

Le corse dopo mezzanotte sono gestite controllando anche il giorno di servizio precedente, dato che il GTFS usa orari come `25:10:00`.

## Scelte

| Scelta | Motivo |
|---|---|
| Posizioni calcolate in proprio invece di usare le VehiclePositions | Anche quelle di BusOne sono stime sul percorso. Così il movimento è fluido, si usa un feed in meno e l'app funziona anche offline |
| JSON invece di protobuf | Nessun decoder da includere, a costo di un traffico maggiore |
| Nessun framework né build | Per un prototipo restano solo file da servire |
| Mappa online con OpenFreeMap e DEM AWS | Nessuna chiave; un pacchetto offline completo arriverà solo se serve |
| Riuso di MapLibre e dello stile del progetto Valsugana | Stesso aspetto e stessa versione già collaudata |

## PWA e offline

| Risorsa | Strategia |
|---|---|
| App e `net.json` | Prima la rete, con ripiego sulla cache dopo 4 secondi |
| Tile di mappa e terreno | Salvati quando vengono visti, massimo 4.000 |
| Feed BusOne | Mai in cache: un dato live vecchio sarebbe fuorviante |

Offline l'app mostra un avviso con la data degli orari, e tutti i mezzi passano a "solo orario". Se lo stile della mappa non è mai stato salvato, parte su uno sfondo neutro e il resto continua a funzionare.

Per pubblicare una nuova versione dell'app bisogna incrementare `VERSION` in `sw.js`, che rimuove le vecchie cache.

## Prossimi passi

1. Pubblicare su GitHub Pages con un'azione giornaliera che esegue `npm run data`.
2. Raccogliere i ritardi su un piccolo servizio esterno per le statistiche: è l'unico pezzo che richiede un backend.
3. Aggiungere un pianificatore di viaggio, in un Web Worker con un algoritmo come RAPTOR.
4. Aggiungere la provincia di Bolzano tramite il GTFS-RT ufficiale di Open Data Hub.
5. Valutare un pacchetto offline completo con PMTiles, come nel progetto Valsugana.
