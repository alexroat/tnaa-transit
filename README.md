# TNAA Transit

Mappa 3D dei trasporti pubblici in Trentino, con orari, ritardi, posizioni stimate e pianificatore di viaggio. È una PWA statica, senza backend. La provincia di Bolzano arriverà dopo.

**Prova l'app: https://alexroat.github.io/tnaa-transit/**

Progetto indipendente, non affiliato a Trentino Trasporti S.p.A., Trenitalia o BusOne. I nomi degli operatori indicano solo la fonte dei dati e appartengono ai rispettivi titolari.

> **Stato: prototipo.** Le posizioni sono stime, non GPS: vedi [Dati e limiti](docs/dati-e-limiti.md).

## Avvio

```sh
npm run serve      # http://localhost:8650
```

Non servono dipendenze: bastano Python 3 e Node. I dati non sono nel repo: la prima volta esegui `npm run data`.

| Comando | Cosa fa |
|---|---|
| `npm run data` | Riscarica i GTFS e rigenera `app/data/net.json` |
| `npm test` | Esegue i test della logica |
| `npm run publish` | Rigenera i dati e pubblica il sito su GitHub Pages |
| `npm run check:live` | Controlla sui feed veri aggancio agli orari e posizioni; ha senso col servizio attivo |

## Funzioni

- Mappa 3D con terreno, bus, Trento-Malé, Valsugana e Brennero
- Colore del mezzo in base al ritardo; i mezzi senza dati live sono vuoti ("solo orario")
- Partenze per fermata o stazione, con ritardo e orario stimato
- Dettaglio corsa: tutte le fermate, percorso sulla mappa, prossima fermata
- Ricerca di fermate e linee, filtri bus/treni/solo live
- Pianificatore di viaggio con bus e treni, anche senza rete
- Pagina "Come funziona" che spiega la stima al pubblico
- Ritardi ogni 5 minuti, con pulsante Aggiorna e pausa quando la pagina non è visibile
- Installabile come PWA; offline restano orari, ricerca, pianificatore e posizioni teoriche
- Avviso quando gli orari stanno per finire

## Licenza

© 2026 Alessandro Roat. Codice, documenti e grafica sono rilasciati con licenza [CC BY-NC 4.0](LICENSE): uso libero per scopi non commerciali, con obbligo di citare l'autore. I dati e le librerie di terzi hanno le loro licenze: vedi [NOTICE.md](NOTICE.md), che riporta anche la citazione da usare.

## Documentazione

- [Architettura](docs/architettura.md): componenti, flusso dei dati, scelte e prossimi passi
- [Dati e limiti](docs/dati-e-limiti.md): fonti, licenze, affidabilità e verifiche fatte
- [Aggiornare i dati](.claude/skills/aggiorna-dati/SKILL.md): procedura per rigenerare gli orari e le corse manuali
