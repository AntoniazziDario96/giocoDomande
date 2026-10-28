(() => {
  'use strict';

  const app = document.getElementById('app');
  const roomTag = document.getElementById('roomTag');
  const offline = document.getElementById('offline');
  const toastEl = document.getElementById('toast');

  const match = location.pathname.match(/^\/r\/([A-Za-z0-9]+)\/?$/);
  const code = match ? match[1].toUpperCase() : null;
  const roomLink = code ? `${location.origin}/r/${code}` : '';

  // ---------- memoria locale (per rientrare dopo un ricaricamento) ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* niente */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* niente */ } },
  };
  const secretKey = (c) => `chs:secret:${c}`;
  const hostKeyKey = (c) => `chs:host:${c}`;

  // ---------- stato ----------
  let state = null; // vista inviata dal server
  let entry = null; // { canJoin, reason } quando non siamo ancora dentro
  let fatal = null; // messaggio di errore bloccante
  let lastKey = '';
  let animateReveal = false;
  const local = {
    rounds: 5,
    name: '',
    question: '',
    answer: '',
    editingAnswer: false,
    guesses: {},
    joinCode: '',
  };

  // ---------- utilità DOM ----------
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    children.flat(Infinity).forEach((c) => {
      if (c == null || c === false) return;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    });
    Object.entries(props || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'value') node.value = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, v);
    });
    return node;
  }

  let toastTimer = null;
  function toast(msg, isError) {
    toastEl.textContent = msg;
    toastEl.className = isError ? 'toast error' : 'toast';
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3200);
  }

  const socket = io();

  function send(event, payload) {
    return new Promise((resolve) => {
      socket.timeout(8000).emit(event, payload || {}, (err, res) => {
        if (err) { toast('Il server non risponde. Controlla la connessione.', true); resolve(null); return; }
        if (res && res.error) { toast(res.error, true); resolve(null); return; }
        resolve(res || {});
      });
    });
  }

  const playerName = (pid) => state?.players.find((p) => p.pid === pid)?.name || 'Qualcuno';
  const paper = (i) => `c${(i % 5) + 1}`;
  const tilt = (i) => `--tilt:${[-1.6, 1.2, -0.6, 1.8, -1.1, 0.7][i % 6]}deg`;

  function counter(value, max) {
    return el('div', { class: 'counter' }, `${value.length}/${max}`);
  }

  function playersList(opts = {}) {
    return el('ul', { class: 'players' }, state.players.map((p) => {
      const done = opts.done ? opts.done(p) : false;
      const extra = opts.extra ? opts.extra(p) : null;
      return el('li', { class: [done ? 'done' : '', p.connected ? '' : 'away'].join(' ').trim() || null },
        done ? el('span', { class: 'tick', 'aria-label': 'fatto' }, '✓') : null,
        p.name,
        p.pid === state.you ? el('span', { class: 'tag' }, '(tu)') : null,
        p.pid === state.hostPid ? el('span', { class: 'tag' }, 'host') : null,
        extra ? el('span', { class: 'tag' }, extra) : null,
        p.connected ? null : el('span', { class: 'tag' }, 'offline'));
    }));
  }

  function questionSlip(text) {
    return el('div', { class: 'slip question', style: '--tilt:-0.8deg' },
      el('span', { class: 'pin', 'aria-hidden': 'true' }),
      el('div', { class: 'hand' }, text));
  }

  function onEnter(fn) {
    return (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); fn(); } };
  }

  // ---------- rendering ----------
  function render() {
    const active = document.activeElement;
    const focusId = active && active.id ? active.id : null;
    let sel = null;
    if (focusId && typeof active.selectionStart === 'number') sel = [active.selectionStart, active.selectionEnd];

    app.replaceChildren(screen());

    if (focusId) {
      const n = document.getElementById(focusId);
      if (n) {
        n.focus({ preventScroll: true });
        if (sel && n.setSelectionRange) { try { n.setSelectionRange(sel[0], sel[1]); } catch { /* niente */ } }
      }
    }
  }

  function screen() {
    if (!code) return homeScreen();
    if (fatal) return fatalScreen(fatal);
    if (!state) return entry ? joinScreen() : el('p', { class: 'muted' }, 'Sto aprendo la stanza…');
    switch (state.phase) {
      case 'lobby': return lobbyScreen();
      case 'writing': return writingScreen();
      case 'answering': return answeringScreen();
      case 'guessing': return guessingScreen();
      case 'reveal': return revealScreen();
      case 'results': return resultsScreen();
      default: return el('p', null, 'Stato sconosciuto.');
    }
  }

  // ---------- home ----------
  function homeScreen() {
    const setRounds = (n) => { local.rounds = Math.max(1, Math.min(20, n)); render(); };

    const create = async () => {
      const res = await send('room:create', { rounds: local.rounds });
      if (!res) return;
      store.set(hostKeyKey(res.code), res.hostKey);
      location.href = `/r/${res.code}`;
    };

    const goCode = () => {
      const c = local.joinCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!c) { toast('Scrivi il codice della stanza.', true); return; }
      location.href = `/r/${c}`;
    };

    return el('div', null,
      el('section', { class: 'hero' },
        el('h1', null, 'Chi l’ha scritto?'),
        el('p', { class: 'lead' }, 'Tutti rispondono alle stesse domande. Poi le risposte si mescolano, senza nomi, e dovete indovinare chi ha scritto cosa.'),
        el('div', { class: 'hero-slips', 'aria-hidden': 'true' },
          el('div', { class: 'slip c1 a' }, el('div', { class: 'hand' }, 'Ho paura delle farfalle. Non ridete.'), el('div', { class: 'guess' }, 'Secondo te: Luca?')),
          el('div', { class: 'slip c2 b' }, el('div', { class: 'hand' }, 'Ho cantato al karaoke a Tokyo, da sola.'), el('div', { class: 'guess' }, 'Secondo te: Sara?')),
          el('div', { class: 'slip c3 c' }, el('div', { class: 'hand' }, 'Pizza con l’ananas, e non me ne pento.'), el('div', { class: 'guess' }, 'Secondo te: Giulia?')))),

      el('section', { class: 'section' },
        el('h2', null, 'Come si gioca'),
        el('ol', { class: 'steps' },
          el('li', null, 'Crea una stanza e manda il link agli amici. Nessuna registrazione.'),
          el('li', null, 'Ognuno sceglie un nome e scrive qualche domanda per il gruppo.'),
          el('li', null, 'Il gioco ne estrae alcune a caso e tutti rispondono, una domanda alla volta.'),
          el('li', null, 'Per ogni domanda vedete tutte le risposte senza nome e abbinate ciascuna a chi l’ha scritta.'),
          el('li', null, 'Un punto per ogni abbinamento giusto. Vince chi ne indovina di più.'))),

      el('section', { class: 'section create' },
        el('h2', null, 'Crea una stanza'),
        el('div', null,
          el('label', { id: 'roundsLabel' }, 'Quante domande giocate?'),
          el('div', { class: 'stepper', role: 'group', 'aria-labelledby': 'roundsLabel' },
            el('button', { class: 'ghost', type: 'button', 'aria-label': 'Una domanda in meno', disabled: local.rounds <= 1, onClick: () => setRounds(local.rounds - 1) }, '−'),
            el('output', { 'aria-live': 'polite' }, local.rounds),
            el('button', { class: 'ghost', type: 'button', 'aria-label': 'Una domanda in più', disabled: local.rounds >= 20, onClick: () => setRounds(local.rounds + 1) }, '+'))),
        el('div', null, el('button', { type: 'button', onClick: create }, 'Crea stanza'))),

      el('section', { class: 'section' },
        el('h3', null, 'Hai già un codice?'),
        el('div', { class: 'row' },
          el('input', {
            id: 'joinCode', type: 'text', class: 'grow', placeholder: 'Es. K7QMP', maxlength: 8,
            autocomplete: 'off', 'aria-label': 'Codice della stanza', value: local.joinCode,
            onInput: (e) => { local.joinCode = e.target.value; }, onKeydown: onEnter(goCode),
          }),
          el('button', { class: 'ghost', type: 'button', onClick: goCode }, 'Entra nella stanza'))));
  }

  function fatalScreen(msg) {
    return el('div', null,
      el('h2', null, 'Stanza non trovata'),
      el('p', { class: 'lead' }, msg),
      el('button', { type: 'button', onClick: () => { location.href = '/'; } }, 'Crea una nuova stanza'));
  }

  // ---------- ingresso ----------
  function joinScreen() {
    if (!entry.canJoin) {
      return el('div', null,
        el('h2', null, 'Non puoi entrare'),
        el('p', { class: 'lead' }, entry.reason || 'Questa stanza non accetta nuovi giocatori.'),
        el('button', { type: 'button', onClick: () => { location.href = '/'; } }, 'Crea una nuova stanza'));
    }
    const join = async () => {
      const name = local.name.trim();
      if (!name) { toast('Scrivi un nome per entrare.', true); return; }
      const res = await send('room:join', { code, name, hostKey: store.get(hostKeyKey(code)) });
      if (res && res.secret) store.set(secretKey(code), res.secret);
    };
    return el('div', null,
      el('h2', null, 'Entra nella partita'),
      el('p', { class: 'lead' }, 'Scegli il nome che vedranno gli altri giocatori.'),
      el('label', { for: 'joinName' }, 'Il tuo nome'),
      el('div', { class: 'row' },
        el('input', {
          id: 'joinName', type: 'text', class: 'grow', maxlength: 20, autocomplete: 'nickname',
          placeholder: 'Es. Giulia', value: local.name,
          onInput: (e) => { local.name = e.target.value; }, onKeydown: onEnter(join),
        }),
        el('button', { type: 'button', onClick: join }, 'Entra')));
  }

  // ---------- sala d'attesa ----------
  function lobbyScreen() {
    const min = state.limits.minPlayers;
    const missing = Math.max(0, min - state.players.length);

    const copy = async () => {
      try {
        await navigator.clipboard.writeText(roomLink);
      } catch {
        const i = document.getElementById('shareLink');
        i.select();
        document.execCommand('copy');
      }
      toast('Link copiato.');
    };
    const share = async () => {
      try { await navigator.share({ title: 'Chi l’ha scritto?', text: 'Entra nella mia stanza:', url: roomLink }); } catch { /* annullato */ }
    };

    return el('div', null,
      el('h2', null, 'Sala d’attesa'),
      el('p', { class: 'lead' }, `In questa partita si giocano ${state.targetRounds} ${state.targetRounds === 1 ? 'domanda' : 'domande'}.`),
      el('label', { for: 'shareLink' }, 'Link per invitare gli amici'),
      el('div', { class: 'share' },
        el('input', { id: 'shareLink', type: 'text', readonly: true, value: roomLink, onFocus: (e) => e.target.select() }),
        el('button', { type: 'button', onClick: copy }, 'Copia link'),
        navigator.share ? el('button', { type: 'button', class: 'ghost', onClick: share }, 'Condividi') : null),

      el('div', { class: 'section' },
        el('h3', null, `Giocatori (${state.players.length})`),
        playersList()),

      el('div', { class: 'section' },
        state.isHost
          ? el('div', null,
            missing > 0
              ? el('p', { class: 'muted' }, `Servono almeno ${min} giocatori: ${missing === 1 ? 'ne manca 1' : `ne mancano ${missing}`}.`)
              : el('p', { class: 'muted' }, 'Quando ci siete tutti, avvia la partita. Dopo l’avvio nessun altro potrà entrare.'),
            el('button', { type: 'button', disabled: missing > 0, onClick: () => send('game:start') }, 'Inizia la partita'))
          : el('p', { class: 'muted' }, `Aspetta che ${playerName(state.hostPid)} avvii la partita.`)));
  }

  // ---------- scrittura domande ----------
  function writingScreen() {
    const w = state.writing;
    const max = state.limits.question;
    const target = state.targetRounds;
    const allReady = w.status.every((s) => s.ready);
    const shortBy = Math.max(0, target - w.poolSize);

    const add = async () => {
      const text = local.question.trim();
      if (!text) { toast('Scrivi una domanda prima di aggiungerla.', true); return; }
      const res = await send('question:add', { text });
      if (res) { local.question = ''; render(); document.getElementById('qText')?.focus(); }
    };

    const statusFor = (pid) => w.status.find((s) => s.pid === pid);

    return el('div', null,
      el('p', { class: 'progress' }, 'Prima fase: le domande'),
      el('h2', null, 'Scrivi domande per il gruppo'),
      el('p', { class: 'lead' }, `Alla fine ne verranno estratte ${target} a caso tra quelle di tutti. Puoi scriverne più di una.`),

      w.myReady
        ? el('div', { class: 'notice' },
          el('p', { style: 'margin:0 0 .6rem' }, 'Hai finito. Aspetta gli altri.'),
          el('button', { type: 'button', class: 'ghost', onClick: () => send('player:ready', { ready: false }) }, 'Voglio aggiungerne altre'))
        : el('div', null,
          el('label', { for: 'qText' }, 'Nuova domanda'),
          el('textarea', {
            id: 'qText', maxlength: max, rows: 3,
            placeholder: 'Es. Qual è la cosa più strana che hai mangiato?',
            value: local.question,
            onInput: (e) => { local.question = e.target.value; e.target.nextSibling.textContent = `${e.target.value.length}/${max}`; },
            onKeydown: onEnter(add),
          }),
          counter(local.question, max),
          el('div', { class: 'row', style: 'margin-top:.6rem' },
            el('button', { type: 'button', onClick: add }, 'Aggiungi domanda'),
            el('button', {
              type: 'button', class: 'ghost', disabled: w.mine.length === 0,
              onClick: () => send('player:ready', { ready: true }),
            }, 'Ho finito'))),

      w.mine.length
        ? el('div', { class: 'section' },
          el('h3', null, `Le tue domande (${w.mine.length})`),
          el('ul', { class: 'my-questions' }, w.mine.map((q, i) => el('li', null,
            el('div', { class: `slip ${paper(i)}`, style: tilt(i) },
              el('div', { class: 'hand' }, q.text),
              w.myReady ? null : el('button', {
                type: 'button', class: 'link', 'aria-label': `Togli la domanda: ${q.text}`,
                onClick: () => send('question:remove', { id: q.id }),
              }, 'Togli'))))))
        : null,

      el('div', { class: 'section' },
        el('h3', null, `Domande scritte in tutto: ${w.poolSize}`),
        playersList({
          done: (p) => statusFor(p.pid)?.ready,
          extra: (p) => { const c = statusFor(p.pid)?.count || 0; return c === 1 ? '1 domanda' : `${c} domande`; },
        }),
        allReady && shortBy > 0
          ? el('p', { class: 'notice', style: 'margin-top:1rem' },
            `Avete finito tutti, ma per giocarne ${target} ${shortBy === 1 ? 'serve ancora 1 domanda' : `servono ancora ${shortBy} domande`}. Aggiungetene altre${state.isHost ? ', oppure inizia con quelle che ci sono.' : '.'}`)
          : null,
        state.isHost && w.poolSize > 0
          ? el('div', { style: 'margin-top:1.2rem' },
            el('p', { class: 'muted small' }, allReady
              ? 'Puoi iniziare subito con le domande scritte finora.'
              : 'La partita parte da sola quando tutti hanno finito. Se qualcuno ci mette troppo, puoi iniziare ora: non potrà più aggiungere domande.'),
            el('button', { type: 'button', class: 'ghost', onClick: () => send('writing:startNow') },
              `Inizia ora con ${Math.min(target, w.poolSize)} ${Math.min(target, w.poolSize) === 1 ? 'domanda' : 'domande'}`))
          : null));
  }

  // ---------- risposte ----------
  function answeringScreen() {
    const a = state.answering;
    const max = state.limits.answer;
    const done = a.myAnswer !== null && !local.editingAnswer;
    const answeredCount = a.answered.length;
    const total = state.players.length;

    const submit = async () => {
      const text = local.answer.trim();
      if (!text) { toast('Scrivi una risposta prima di inviarla.', true); return; }
      const res = await send('answer:submit', { text });
      if (res) { local.editingAnswer = false; render(); }
    };

    return el('div', null,
      el('p', { class: 'progress' }, `Seconda fase: le risposte. Domanda ${a.index + 1} di ${a.total}`),
      questionSlip(a.question),

      el('div', { style: 'margin-top:2rem' },
        done
          ? el('div', null,
            el('p', { class: 'muted' }, 'La tua risposta:'),
            el('div', { class: 'slip c1', style: tilt(1) }, el('div', { class: 'hand' }, a.myAnswer)),
            el('div', { class: 'row', style: 'margin-top:1rem' },
              el('p', { class: 'muted', style: 'margin:0' }, 'Inviata. Aspetta gli altri.'),
              el('button', {
                type: 'button', class: 'ghost',
                onClick: () => { local.editingAnswer = true; local.answer = a.myAnswer; render(); document.getElementById('aText')?.focus(); },
              }, 'Modifica')))
          : el('div', null,
            el('label', { for: 'aText' }, 'La tua risposta'),
            el('textarea', {
              id: 'aText', maxlength: max, rows: 3, value: local.answer,
              placeholder: 'Rispondi sinceramente: gli altri dovranno capire che sei tu.',
              onInput: (e) => { local.answer = e.target.value; e.target.nextSibling.textContent = `${e.target.value.length}/${max}`; },
              onKeydown: onEnter(submit),
            }),
            counter(local.answer, max),
            el('div', { class: 'row', style: 'margin-top:.6rem' },
              el('button', { type: 'button', onClick: submit }, local.editingAnswer ? 'Salva risposta' : 'Invia risposta'),
              local.editingAnswer
                ? el('button', { type: 'button', class: 'ghost', onClick: () => { local.editingAnswer = false; render(); } }, 'Annulla')
                : null))),

      el('div', { class: 'section' },
        el('h3', null, `Hanno risposto ${answeredCount} su ${total}`),
        playersList({ done: (p) => a.answered.includes(p.pid) }),
        hostSkip(answeredCount > 0 && answeredCount < total, 'Vai avanti senza chi non ha risposto')));
  }

  function hostSkip(show, label) {
    if (!state.isHost || !show) return null;
    return el('div', { style: 'margin-top:1.2rem' },
      el('p', { class: 'muted small' }, 'Se qualcuno è uscito o ci mette troppo, puoi andare avanti senza di lui.'),
      el('button', { type: 'button', class: 'ghost', onClick: () => send('host:skip') }, label));
  }

  // ---------- indovina ----------
  function guessingScreen() {
    const g = state.guessing;
    const key = String(g.index);
    if (!local.guesses[key]) local.guesses[key] = g.answers.map(() => '');
    const picks = local.guesses[key];
    const submitted = g.myGuess !== null;
    const total = state.players.length;
    const needed = g.answers.filter((x) => !x.mine).length;
    const filled = g.answers.filter((x, i) => !x.mine && picks[i]).length;

    const submit = async () => {
      const guesses = g.answers.map((x, i) => (x.mine ? null : picks[i]));
      await send('guess:submit', { guesses });
    };

    const slips = el('div', { class: 'slips' }, g.answers.map((ans, i) => {
      let foot;
      if (ans.mine) {
        foot = el('div', { class: 'yours' }, 'La tua risposta');
      } else if (submitted) {
        foot = el('div', null, 'Hai detto: ', el('strong', null, playerName(g.myGuess[i])));
      } else {
        const usedElsewhere = new Set(picks.filter((p, j) => p && j !== i));
        foot = el('div', null,
          el('label', { for: `g-${i}` }, 'Chi l’ha scritta?'),
          el('select', {
            id: `g-${i}`, value: picks[i],
            onChange: (e) => { picks[i] = e.target.value; render(); },
          },
          el('option', { value: '' }, 'Scegli…'),
          g.candidates.map((c) => el('option', { value: c.pid, disabled: usedElsewhere.has(c.pid) }, c.name))));
      }
      return el('div', { class: `slip ${paper(i)}`, style: tilt(i) },
        el('div', { class: 'hand' }, ans.text),
        el('div', { class: 'slip-foot' }, foot));
    }));

    return el('div', null,
      el('p', { class: 'progress' }, `Terza fase: indovina. Domanda ${g.index + 1} di ${g.total}`),
      questionSlip(g.question),
      el('p', { class: 'muted', style: 'margin-top:1.5rem' }, submitted
        ? 'Abbinamenti inviati. Aspetta gli altri.'
        : 'Abbina ogni risposta alla persona che secondo te l’ha scritta. Ogni nome si usa una volta sola.'),
      slips,
      submitted ? null : el('div', { class: 'row', style: 'margin-top:1.75rem' },
        el('button', { type: 'button', disabled: filled < needed, onClick: submit }, 'Conferma abbinamenti'),
        el('span', { class: 'muted small' }, `${filled} su ${needed}`)),
      el('div', { class: 'section' },
        el('h3', null, `Hanno confermato ${g.submitted.length} su ${total}`),
        playersList({ done: (p) => g.submitted.includes(p.pid) }),
        hostSkip(g.submitted.length > 0 && g.submitted.length < total, 'Mostra le risposte senza aspettare')));
  }

  // ---------- rivelazione ----------
  function revealScreen() {
    const r = state.reveal;
    const slips = el('div', { class: `slips${animateReveal ? ' reveal-slips' : ''}` }, r.answers.map((ans, i) => {
      let verdict = null;
      if (!ans.mine) {
        if (!ans.myGuessName) verdict = el('div', { class: 'verdict no' }, 'Non hai votato');
        else if (ans.correct) verdict = el('div', { class: 'verdict ok' }, '✓ Hai indovinato');
        else verdict = el('div', { class: 'verdict no' }, `✗ Avevi detto ${ans.myGuessName}`);
      }
      return el('div', { class: `slip ${paper(i)}`, style: `${tilt(i)};animation-delay:${i * 140}ms` },
        el('div', { class: 'hand' }, ans.text),
        el('div', { class: 'slip-foot' },
          el('div', { class: 'author' }, ans.mine ? 'La tua risposta' : `Scritta da ${ans.authorName}`),
          verdict));
    }));
    animateReveal = false;

    return el('div', null,
      el('p', { class: 'progress' }, `Domanda ${r.index + 1} di ${r.total}: ecco chi l’ha scritto`),
      questionSlip(r.question),
      slips,
      el('div', { class: 'section' },
        el('h3', null, 'Punteggio'),
        el('ol', { class: 'board' }, r.roundScores.map((s, i, all) => el('li', { class: s.pid === state.you ? 'me' : null },
          el('span', { class: 'rank' }, all.findIndex((x) => x.total === s.total) + 1),
          el('span', { class: 'who' }, s.name, s.pid === state.you ? ' (tu)' : '',
            el('span', { class: 'plus' }, `+${s.round}`)),
          el('span', { class: 'pts' }, s.total))))),
      el('div', { style: 'margin-top:1.75rem' },
        state.isHost
          ? el('button', { type: 'button', onClick: () => send('round:next') }, r.isLast ? 'Vedi la classifica' : 'Prossima domanda')
          : el('p', { class: 'muted' }, `Aspetta che ${playerName(state.hostPid)} vada avanti.`)));
  }

  // ---------- classifica ----------
  function resultsScreen() {
    const res = state.results;
    const rows = res.rows;
    if (!rows.length) {
      return el('div', null,
        el('h2', null, 'Partita finita'),
        el('p', { class: 'lead' }, 'Non ci sono state abbastanza risposte per indovinare.'),
        actionsAfter());
    }
    const winners = rows.filter((r) => r.rank === 1);
    const headline = winners.length > 1
      ? `Pari merito tra ${winners.map((w) => w.name).join(', ').replace(/, ([^,]*)$/, ' e $1')}!`
      : `Vince ${winners[0].name}!`;
    const pts = winners[0].points;

    return el('div', null,
      el('h2', null, 'Classifica finale'),
      el('p', { class: 'lead' }, `${headline} ${pts === 1 ? '1 risposta indovinata' : `${pts} risposte indovinate`}.`),
      el('ol', { class: 'board final' }, rows.map((r) => el('li', { class: [r.rank === 1 ? 'top' : '', r.pid === state.you ? 'me' : ''].join(' ').trim() || null },
        el('span', { class: 'rank' }, r.rank),
        el('span', { class: 'who' }, r.name, r.pid === state.you ? ' (tu)' : ''),
        el('span', { class: 'pts' }, r.points, el('small', null, ` / ${res.maxPoints}`))))),
      actionsAfter());
  }

  function actionsAfter() {
    return el('div', { class: 'row', style: 'margin-top:2rem' },
      state.isHost ? el('button', { type: 'button', onClick: () => send('game:again') }, 'Gioca ancora con questo gruppo') : null,
      el('button', { type: 'button', class: 'ghost', onClick: () => { location.href = '/'; } }, 'Crea una nuova stanza'),
      state.isHost ? null : el('p', { class: 'muted small', style: 'margin:0' }, `Se ${playerName(state.hostPid)} fa ripartire la partita, rientri in automatico.`));
  }

  // ---------- connessione ----------
  async function hello() {
    const secret = store.get(secretKey(code));
    const res = await new Promise((resolve) => {
      socket.timeout(8000).emit('room:hello', { code, secret }, (err, r) => resolve(err ? null : r));
    });
    if (!res) { toast('Il server non risponde. Riprovo…', true); setTimeout(hello, 2500); return; }
    if (res.error) { fatal = res.error; render(); return; }
    if (!res.joined) {
      if (secret) store.del(secretKey(code));
      state = null;
      entry = { canJoin: res.canJoin, reason: res.reason };
      render();
    }
  }

  socket.on('connect', () => {
    offline.hidden = true;
    if (code) hello();
  });
  socket.on('disconnect', () => { offline.hidden = false; });

  socket.on('state', (s) => {
    const key = `${s.phase}:${s.answering?.index ?? s.guessing?.index ?? s.reveal?.index ?? ''}`;
    if (key !== lastKey) {
      if (s.phase === 'reveal') animateReveal = true;
      if (s.phase === 'answering') { local.answer = ''; local.editingAnswer = false; }
      if (s.phase === 'lobby') { local.guesses = {}; local.question = ''; }
      if (lastKey) window.scrollTo({ top: 0, behavior: 'smooth' });
      lastKey = key;
    }
    state = s;
    entry = null;
    render();
  });

  if (!code) document.querySelector('.brand').hidden = true;
  if (code) {
    roomTag.hidden = false;
    roomTag.replaceChildren('Stanza ', el('strong', null, code));
    document.title = `Stanza ${code} – Chi l’ha scritto?`;
  }
  render();
})();
