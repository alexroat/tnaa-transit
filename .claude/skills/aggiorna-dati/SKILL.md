---
name: aggiorna-dati
description: Rigenera i dati offline di TNAA Transit (app/data/net.json e version.json) e riscrive a mano le corse che mancano dai GTFS, leggendo gli orari dal sito di Trentino Trasporti. Da usare quando gli orari cambiano o scadono, quando l'app avvisa "orari noti solo fino al", a ogni cambio orario ferroviario (dicembre e giugno) e quando l'utente chiede di aggiornare gli orari.
---

# Aggiornare i dati offline

L'app legge solo `app/data/net.json`. Lo genera `scripts/build_data.py` da due fonti automatiche (GTFS via BusOne) e dai file manuali `data/extra/*.json`. Il resto di questa guida serve per i file manuali, perché nessun programma può scriverli: gli orari esistono solo in PDF.

Su GitHub il workflow `pages.yml` rigenera e pubblica i dati ogni notte. Le fasi 2-5 restano manuali: servono ogni volta che cambiano le corse di `data/extra/`. Fatte quelle, basta fare commit e push: il workflow fa il resto.

## 1. Rigenera e guarda le date

```sh
npm run data
cat app/data/version.json
```

`validity` dice fino a quando arriva ogni gruppo di linee. Confronta le date con oggi e con la pagina Ferrovia del sito. Se i "Treni regionali" arrivano oltre la vecchia data, Trenitalia ha pubblicato il nuovo orario.

`npm run data` riscarica tutto. `python3 -I scripts/build_data.py --no-download` riusa i file in `.cache/`.

## 2. Trova l'orario in vigore

Il sito risponde 403 a curl e agli script. Non aggirarlo: niente User-Agent finti né altri trucchi. Apri le pagine nel Chrome dell'utente con Claude in Chrome, come farebbe una persona, e rifiuta i cookie non necessari.

- Treni: `https://www.trentinotrasporti.it/it/viaggia-con-noi/ferrovia`. Cerca i PDF "TRENTO - BORGO V. - BASSANO", andata e ritorno, e le note di servizio sulla stessa pagina: possono cambiare i treni in un certo periodo.
- Bus extraurbani: `.../it/viaggia-con-noi/extraurbano`, poi zona, linea e "Visualizza orari linea". Il PDF ha un indirizzo come `/pdforari/extraurbani/linee/OrariDiDirettrice-E26I-401INA.PDF`, ma la sigla cambia: prendilo dal link.
- Bus urbani: `.../it/viaggia-con-noi/urbano`, con PDF separati per feriale e festivo.

I PDF si leggono da immagine: `get_page_text` non restituisce nulla. Fai lo screenshot e poi `zoom` su blocchi di colonne non troppo larghi. Se il cursore copre una cifra, spostalo e ripeti lo zoom. Non indovinare.

## 3. Aggiorna `data/extra/valsugana.json`

Prima scopri cosa manca davvero. Nel PDF contano le colonne con IF = TT: treni `R` e `BUS`. Le colonne TI sono già nel GTFS Trenitalia. Molte `BUS` TT sono già nel GTFS TT sotto la linea B450: elenca le corse con il comando in fondo e **non ricopiarle**.

Per ogni corsa mancante scrivi una riga in `trips`:

```json
{"n": "16915", "route": "treno", "days": "festivi", "times": "8:05 8:09 - 8:16"}
```

- `n`: numero nel PDF. `route`: `treno` o `bus`, come in `routes`.
- `days`: nota (1) = `lavorativi`, (2) = `festivi`, (3) = `tutti`.
- `times`: un valore per ogni voce di `rows`, nello stesso ordine e con `-` dove non ferma. Le stazioni con arrivo e partenza compaiono due volte in `rows`. I `-` in coda si possono omettere.

Aggiorna anche `validFrom`, `validTo`, `readOn`, `sources` e `holidays`: i festivi infrasettimanali dell'intervallo, compresi Santo Patrono e simili se il PDF li tratta come festivi.

`shapes` indica la corsa da cui copiare il percorso. Se il build dice "Corsa di riferimento non trovata", quel treno non esiste più: scegli un treno dello stesso percorso completo con la stessa direzione.

Se per il nuovo periodo non hai un orario affidabile, lascia il file com'è. Le sue corse spariscono da sole dopo `validTo` e l'app lo segnala. Non allungare mai `validTo` senza una fonte.

Per una nuova tratta crea un altro file in `data/extra/` con la stessa struttura.

## 4. Verifica

```sh
npm run data
npm test
```

Il build si ferma se una corsa ha orari fuori sequenza, più orari che fermate o una fermata sconosciuta.

`ATTENZIONE: forse doppia` significa stesso inizio e stessa fine di una corsa esistente. Controlla: se i giorni sono diversi va bene (16934 festivo e 16114 feriale), se sono uguali toglila dal file manuale. È successo con TT922, TT02, TT04, TT926, TT938 e TT942, già presenti nella B450.

Poi rifai il confronto a campione descritto in `docs/dati-e-limiti.md`: almeno una linea per zona, su feriale scolastico, sabato, domenica, festivo infrasettimanale e periodo non scolastico. Trascrivi le colonne e cerca nel `net.json` due fermate per colonna. Comparando a occhio si sbaglia.

Apri infine l'app con `npm run serve` su `http://localhost:8650/` e cerca una corsa manuale, per esempio partenze dalla stazione di Levico.

## 5. Chiudi

- Aggiorna la tabella di confronto in `docs/dati-e-limiti.md` con date ed esiti veri, comprese le differenze.
- Non serve toccare `sw.js`: `version.json` fa scaricare gli orari nuovi. Incrementa `VERSION` solo se cambia il codice dell'app.
- Fai commit e push solo se l'utente lo chiede. Un file `data/extra` scaduto viene ignorato dal build: non blocca la pubblicazione.

## Comando utile

Corse già presenti per una linea, con i tipi di giorno:

```sh
node -e "
const fs=require('fs');const n=JSON.parse(fs.readFileSync('app/data/net.json'));
const i=new Set(n.routes.flatMap((r,x)=>r[1]==='B450'?[x]:[]));
for(const t of n.trips)if(i.has(t[1])){const p=n.patterns[t[4]];console.log(Math.floor(t[5]/3600)+':'+String(t[5]%3600/60).padStart(2,'0'),n.stops[p[1][0]][1],'->',n.stops[p[1].at(-1)][1],n.services[t[2]][0])}"
```
