# TNAA Transit

PWA statica per i trasporti del Trentino. Architettura in `docs/architettura.md`, fonti e limiti in `docs/dati-e-limiti.md`.

- Per aggiornare gli orari o riscrivere le corse manuali segui la skill `aggiorna-dati` (`.claude/skills/aggiorna-dati/SKILL.md`).
- Le posizioni sono stime: non presentarle mai come GPS. Niente orari simulati né ritardi inventati.
- Nome pubblico: TNAA Transit. Non usare "Trentino Trasporti" o "TT" nel nome del prodotto: il marchio è registrato. I nomi degli operatori si usano solo per indicare la fonte dei dati.
- Non aggirare il 403 del sito di Trentino Trasporti: i suoi PDF si leggono dal Chrome dell'utente.
