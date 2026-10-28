# Chi l’ha scritto?

Gioco di gruppo nel browser. Si entra con un link, senza registrazione: ognuno scrive domande, tutti rispondono e poi si indovina chi ha scritto ogni risposta.

## Come funziona una partita

1. Chi crea la stanza sceglie quante domande giocare (da 1 a 20) e manda il link agli amici.
2. Ognuno entra scegliendo un nome. Servono almeno 3 giocatori. Chi ha creato la stanza la avvia.
3. Tutti scrivono domande, quante vogliono (almeno una). Quando tutti hanno premuto "Ho finito", il gioco ne estrae a caso il numero scelto. Se le domande non bastano, chi ha creato la stanza può partire con quelle che ci sono.
4. Si risponde una domanda alla volta: si passa alla successiva quando hanno risposto tutti.
5. Per ogni domanda compaiono tutte le risposte senza nome e ognuno le abbina alle persone. Poi si vede chi aveva scritto cosa e i punti del turno.
6. Un punto per ogni abbinamento giusto. Alla fine compare la classifica.

Se qualcuno ricarica la pagina o perde la connessione, riaprendo il link rientra con lo stesso nome. Se qualcuno sparisce, chi ha creato la stanza può andare avanti senza aspettarlo.

## Provarlo sul tuo computer

Serve [Node.js](https://nodejs.org) versione 18 o successiva.

```bash
npm install
npm start
```

Poi apri http://localhost:3000. Per provare da solo, apri la stanza in più finestre in incognito.

Per giocare con chi è sulla tua stessa rete Wi‑Fi, gli altri possono usare l’indirizzo IP del tuo computer, ad esempio `http://192.168.1.20:3000`.

## Metterlo online gratis (Render)

1. Crea un repository su GitHub e caricaci questi file.
2. Su [render.com](https://render.com) crea un account e scegli **New → Web Service**, collegando il repository.
3. Imposta:
   - Build command: `npm install`
   - Start command: `npm start`
   - Piano: Free
4. Dopo il deploy Render ti dà un indirizzo tipo `https://chi-lha-scritto.onrender.com`: è il sito da condividere.

Due cose da sapere sul piano gratuito: dopo circa 15 minuti senza visite il server si addormenta e la prima apertura successiva impiega fino a un minuto. Inoltre le stanze stanno solo in memoria, quindi un riavvio del server cancella le partite in corso.

Funziona allo stesso modo su altri servizi che supportano Node.js e WebSocket, come Railway o Fly.io.

## File

Tutti i file stanno nella stessa cartella, senza sottocartelle.

- `server.js`: stanze, fasi di gioco e punteggi. Il server non manda mai a nessuno l’autore di una risposta prima della rivelazione.
- `index.html`, `style.css`, `app.js`: l’interfaccia.

Le stanze inattive vengono cancellate automaticamente dopo qualche ora.
