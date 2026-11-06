# TN Monitor

Mappa 3D di bus e treni del Trentino, con orari, ritardi e posizioni stimate. È una PWA statica, senza backend.

> **Stato: prototipo.** Le posizioni sono stime, non GPS: vedi [Dati e limiti](docs/dati-e-limiti.md).

## Avvio

```sh
npm run serve      # http://localhost:8650
```

Non servono dipendenze: bastano Python 3 e Node. I dati sono già in `app/data/net.json`.

| Comando | Cosa fa |
|---|---|
| `npm run data` | Riscarica i GTFS e rigenera `app/data/net.json` |
| `npm test` | Esegue i test della logica |
| `npm run check:live` | Controlla sui feed veri aggancio agli orari e posizioni; ha senso col servizio attivo |

## Funzioni

- Mappa 3D con terreno, bus, Trento-Malé, Valsugana e Brennero
- Colore del mezzo in base al ritardo; i mezzi senza dati live sono vuoti ("solo orario")
- Partenze per fermata o stazione, con ritardo e orario stimato
- Dettaglio corsa: tutte le fermate, percorso sulla mappa, prossima fermata
- Ricerca di fermate e linee, filtri bus/treni/solo live
- Pagina "Come funziona" che spiega la stima al pubblico
- Installabile come PWA; offline restano orari, ricerca e posizioni teoriche

## Documentazione

- [Architettura](docs/architettura.md): componenti, flusso dei dati, scelte e prossimi passi
- [Dati e limiti](docs/dati-e-limiti.md): fonti, licenze, affidabilità e verifiche fatte
