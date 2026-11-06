# Dati e limiti

## Fonti

| Dato | Fonte | Natura |
|---|---|---|
| Orari bus e Trento-Malé | [BusOne `/trentino`](https://proxy.busone.app/trentino/), da Trentino Trasporti | Orario pubblicato, con calendario provvisorio |
| Orari treni | [BusOne `/trenitalia`](https://proxy.busone.app/trenitalia/), dal NAP/CCISS | Orario pubblicato, con calendario provvisorio |
| Ritardi bus | BusOne `/trentino` | Passaggi osservati e **previsioni statistiche** per le fermate successive |
| Ritardi treni | BusOne `/trenitalia` | **Dichiarati dall'operatore** |
| Posizioni | Calcolate dall'app | **Stime**, mai GPS |
| Mappa | OpenFreeMap, dati OpenStreetMap | Tile vettoriali |
| Terreno | Terrain Tiles su AWS (Mapzen) | DEM |

Trentino Trasporti non pubblica un GTFS-RT ufficiale. L'API dell'app Muoversi in Trentino è protetta da password: le credenziali che circolano in repository pubblici non vengono usate.

## Condizioni d'uso di BusOne

- Gratis solo per uso non commerciale di privati, enti non profit e ONG. Gli usi commerciali e le altre organizzazioni richiedono il consenso scritto di BusOne (info@busone.app).
- L'attribuzione è obbligatoria e compare già sulla mappa: BusOne, fonte originale e OpenStreetMap.
- Il servizio può essere negato o interrotto in qualsiasi momento.
- Le richieste devono includere `X-BusOne-Client` e `X-BusOne-Use`. L'app invia `tnttmonitor-poc` e `personal`, che oggi non generano avvisi. La documentazione però chiede anche un contatto, da aggiungere prima di una pubblicazione.
- Restano valide le licenze delle fonti. Per Trentino Trasporti è CC BY, indicata come 2.5 dall'operatore e 4.0 dal portale provinciale.

## Verifiche fatte (6 novembre 2026, ore 8:45, servizio attivo)

| Verifica | Esito |
|---|---|
| Test della logica | 6 superati, 1 si attiva solo con un campione reale |
| Corse GTFS rispetto ai file ufficiali di Trentino Trasporti | Identiche per ogni linea: 6.793 in totale, 4.634 nel giorno provato |
| TripUpdates dei bus agganciati agli orari | 152 su 152, nessuna corsa fuori orario |
| Mezzi in viaggio | 191, di cui 122 con dati live |
| Ritardi | 6 in anticipo, 41 in orario, 54 da 2 a 5 min, 13 da 5 a 10 min, 8 oltre |
| Distanza dalle posizioni BusOne, bus | Mediana 484 m, massimo 11,5 km, su 107 mezzi |
| Distanza dalle posizioni BusOne, treni | Mediana 909 m, massimo 5,2 km, su 16 treni |
| Prossima fermata rispetto a BusOne | Bus: uguale 44, a una fermata 39, su 107. Treni: uguale 8, a una fermata 8, su 16 |
| Offline (prova della notte, prima delle ultime modifiche) | Con server spento e rete staccata funzionano apertura, ricerca e partenze |

BusOne è a sua volta una stima, quindi il confronto misura la coerenza fra due calcoli, non la distanza dal mezzo reale.

La verifica copre un solo momento della giornata. I casi rari vanno riletti col tempo: per esempio il feed ha riportato un B231 a +94 minuti, dato che arriva così dalla fonte e non è stato possibile confermare.

## Comportamenti del feed bus da ricordare

- Il ritardo attuale è nel campo `delay` della corsa.
- Le fermate già superate compaiono con un orario schiacciato su "adesso": il loro ritardo è un artefatto e va ignorato. Usarlo aveva portato a mostrare ritardi finti oltre un'ora.
- Ogni orario riporta `uncertainty: 600`, cioè 10 minuti, su tutti i 4.679 valori del campione.
- Il feed non segnala un arrivo in fermata: non ci sono eventi di passaggio. Per le statistiche servirà capire come ricavare quelli osservati.

## Non ancora verificato

- **Copertura live nell'arco della giornata:** al momento della prova circa un terzo dei mezzi era senza dati live, compresi molti bus della Valsugana.
- **Traffico:** ogni 30 secondi si scaricano circa 60 KB compressi per i bus e 130 KB per i treni, cioè circa 23 MB l'ora (7 bus, 16 treni). Il feed treni è nazionale e solo una trentina di corse su circa 750 riguarda il Trentino. GTFS-RT non prevede filtri lato server e BusOne ignora i parametri provati (`route_id`, `trip_id`, `stop_id`, `bbox`, `agency`, `limit`, `region`); anche il protobuf pesa quasi uguale (121 KB contro 128 KB).

## Limiti noti

- Mancano i treni di altri operatori sul Brennero, come ÖBB e DB, se non sono nel feed Trenitalia.
- Il calendario di BusOne è indicato come provvisorio.
- L'ora è quella del dispositivo: se è sbagliata, sono sbagliate anche le posizioni.
- La mezzanotte dei cambi d'ora è approssimata: in quei due giorni l'orario delle corse può sbagliare di un'ora.
- Senza un aggiornamento giornaliero di `net.json` gli ID degli orari possono smettere di coincidere con quelli live.
- Dipende da un solo servizio di terzi. Sostituirlo significa cambiare gli URL in `build_data.py` e `main.js`, purché la nuova fonte parli GTFS-RT.
