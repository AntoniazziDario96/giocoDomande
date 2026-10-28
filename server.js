// Chi l'ha scritto? — server di gioco
// Tutto lo stato vive in memoria: se il server si riavvia, le stanze attive si perdono.

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const LIMITS = {
  name: 20,
  question: 200,
  answer: 250,
  minPlayers: 3,
  maxPlayers: 20,
  questionsPerPlayer: 10,
  minRounds: 1,
  maxRounds: 20,
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

// Tutti i file stanno nella stessa cartella: il server espone solo questi tre.
const page = (file) => (req, res) => res.sendFile(path.join(__dirname, file));
app.get('/', page('index.html'));
app.get('/style.css', page('style.css'));
app.get('/app.js', page('app.js'));
app.get('/r/:code', page('index.html'));
app.get('/health', (req, res) => res.send('ok'));

/** @type {Map<string, any>} */
const rooms = new Map();

// ---------- utilità ----------

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  } while (rooms.has(code));
  return code;
}
const token = () => crypto.randomBytes(16).toString('hex');
const shortId = () => crypto.randomBytes(6).toString('hex');

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function clean(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };

// ---------- stanza ----------

function createRoom(rounds) {
  const room = {
    code: makeCode(),
    hostKey: token(),
    hostPid: null,
    hostByKey: false,
    targetRounds: rounds,
    phase: 'lobby', // lobby | writing | answering | guessing | reveal | results
    players: [], // { pid, secret, name, socketId, connected, ready, removeTimer }
    pool: [], // { id, text, authorPid }
    rounds: [], // { question, answers: Map<pid,text>, order: [pid], guesses: Map<pid, (pid|null)[]> }
    current: 0,
    lastActive: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

const findBySecret = (room, secret) => room.players.find((p) => p.secret === secret);
const playerByPid = (room, pid) => room.players.find((p) => p.pid === pid);
const nameOf = (room, pid) => playerByPid(room, pid)?.name ?? 'Giocatore uscito';

function ensureHost(room) {
  if (room.hostPid && playerByPid(room, room.hostPid)) return;
  const next = room.players.find((p) => p.connected) || room.players[0];
  room.hostPid = next ? next.pid : null;
  room.hostByKey = false;
}

function removePlayer(room, pid) {
  room.players = room.players.filter((p) => p.pid !== pid);
  ensureHost(room);
}

// ---------- fasi ----------

function startWriting(room) {
  room.phase = 'writing';
  room.pool = [];
  room.rounds = [];
  room.current = 0;
  room.players.forEach((p) => { p.ready = false; });
}

function startAnswering(room, count) {
  const chosen = shuffle(room.pool).slice(0, count);
  room.rounds = chosen.map((q) => ({
    question: q.text,
    answers: new Map(),
    order: [],
    guesses: new Map(),
  }));
  room.current = 0;
  room.phase = 'answering';
}

function maybeFinishWriting(room) {
  const allReady = room.players.length > 0 && room.players.every((p) => p.ready);
  if (allReady && room.pool.length >= room.targetRounds) {
    startAnswering(room, room.targetRounds);
  }
}

function advanceAnswering(room) {
  room.current += 1;
  if (room.current >= room.rounds.length) startGuessing(room);
}

function maybeFinishAnswer(room) {
  const round = room.rounds[room.current];
  if (room.players.every((p) => round.answers.has(p.pid))) advanceAnswering(room);
}

function startGuessing(room) {
  // Per indovinare servono almeno due risposte in una domanda.
  room.rounds = room.rounds.filter((r) => r.answers.size >= 2);
  room.rounds.forEach((r) => {
    r.order = shuffle([...r.answers.keys()]);
    r.guesses = new Map();
  });
  room.current = 0;
  room.phase = room.rounds.length ? 'guessing' : 'results';
}

function maybeFinishGuess(room) {
  const round = room.rounds[room.current];
  if (room.players.every((p) => round.guesses.has(p.pid))) room.phase = 'reveal';
}

function roundPoints(round, pid) {
  const guess = round.guesses.get(pid);
  if (!guess) return 0;
  return round.order.reduce((sum, author, i) => sum + (author !== pid && guess[i] === author ? 1 : 0), 0);
}

function scores(room, upToIndex) {
  const totals = new Map(room.players.map((p) => [p.pid, 0]));
  room.rounds.slice(0, upToIndex + 1).forEach((r) => {
    totals.forEach((v, pid) => totals.set(pid, v + roundPoints(r, pid)));
  });
  return totals;
}

function leaderboard(room) {
  const totals = scores(room, room.rounds.length - 1);
  const maxPoints = room.rounds.reduce((s, r) => s + r.order.length - 1, 0);
  const sorted = room.players
    .map((p) => ({ pid: p.pid, name: p.name, points: totals.get(p.pid) || 0 }))
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, 'it'));
  let rank = 0;
  let prev = null;
  sorted.forEach((row, i) => {
    if (row.points !== prev) { rank = i + 1; prev = row.points; }
    row.rank = rank;
  });
  return { rows: sorted, maxPoints };
}

// ---------- vista per ciascun giocatore (mai rivelare gli autori prima del tempo) ----------

function viewFor(room, me) {
  const v = {
    code: room.code,
    phase: room.phase,
    you: me.pid,
    hostPid: room.hostPid,
    isHost: room.hostPid === me.pid,
    targetRounds: room.targetRounds,
    limits: LIMITS,
    players: room.players.map((p) => ({ pid: p.pid, name: p.name, connected: p.connected })),
  };

  if (room.phase === 'writing') {
    v.writing = {
      poolSize: room.pool.length,
      mine: room.pool.filter((q) => q.authorPid === me.pid).map((q) => ({ id: q.id, text: q.text })),
      myReady: me.ready,
      status: room.players.map((p) => ({
        pid: p.pid,
        ready: p.ready,
        count: room.pool.filter((q) => q.authorPid === p.pid).length,
      })),
    };
  }

  if (room.phase === 'answering') {
    const r = room.rounds[room.current];
    v.answering = {
      index: room.current,
      total: room.rounds.length,
      question: r.question,
      myAnswer: r.answers.get(me.pid) ?? null,
      answered: [...r.answers.keys()],
    };
  }

  if (room.phase === 'guessing' || room.phase === 'reveal') {
    const r = room.rounds[room.current];
    const myGuess = r.guesses.get(me.pid) ?? null;
    const base = {
      index: room.current,
      total: room.rounds.length,
      question: r.question,
    };
    if (room.phase === 'guessing') {
      v.guessing = {
        ...base,
        answers: r.order.map((pid, i) => ({ i, text: r.answers.get(pid), mine: pid === me.pid })),
        candidates: r.order.filter((pid) => pid !== me.pid).map((pid) => ({ pid, name: nameOf(room, pid) })),
        myGuess,
        submitted: [...r.guesses.keys()],
      };
    } else {
      const totals = scores(room, room.current);
      v.reveal = {
        ...base,
        isLast: room.current === room.rounds.length - 1,
        answers: r.order.map((pid, i) => ({
          text: r.answers.get(pid),
          authorPid: pid,
          authorName: nameOf(room, pid),
          mine: pid === me.pid,
          myGuessName: myGuess && myGuess[i] ? nameOf(room, myGuess[i]) : null,
          correct: !!(myGuess && myGuess[i] === pid),
        })),
        roundScores: room.players
          .map((p) => ({ pid: p.pid, name: p.name, round: roundPoints(r, p.pid), total: totals.get(p.pid) || 0 }))
          .sort((a, b) => b.total - a.total || b.round - a.round),
        maxRound: r.order.length - 1,
      };
    }
  }

  if (room.phase === 'results') v.results = leaderboard(room);

  return v;
}

function broadcast(room) {
  room.lastActive = Date.now();
  room.players.forEach((p) => {
    if (p.socketId) io.to(p.socketId).emit('state', viewFor(room, p));
  });
}

// ---------- socket ----------

io.on('connection', (socket) => {
  const ctx = () => {
    const room = rooms.get(socket.data.code);
    if (!room) fail('La stanza non esiste più.');
    const me = playerByPid(room, socket.data.pid);
    if (!me) fail('Non fai parte di questa stanza.');
    return { room, me };
  };
  const requireHost = (room, me) => { if (room.hostPid !== me.pid) fail('Solo chi ha creato la stanza può farlo.'); };
  const requirePhase = (room, phase) => { if (room.phase !== phase) fail('Questa azione non è disponibile ora.'); };

  // Registra un evento: gestisce errori e risposta (ack) in un unico punto.
  const on = (event, handler) => {
    socket.on(event, (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const result = handler(payload || {});
        reply({ ok: true, ...(result || {}) });
      } catch (err) {
        if (err instanceof GameError) reply({ error: err.message });
        else { console.error(err); reply({ error: 'Errore inatteso, riprova.' }); }
      }
    });
  };

  const attach = (room, player) => {
    if (player.removeTimer) { clearTimeout(player.removeTimer); player.removeTimer = null; }
    player.socketId = socket.id;
    player.connected = true;
    socket.data.code = room.code;
    socket.data.pid = player.pid;
  };

  on('room:create', ({ rounds }) => {
    const n = Math.min(LIMITS.maxRounds, Math.max(LIMITS.minRounds, parseInt(rounds, 10) || 5));
    const room = createRoom(n);
    return { code: room.code, hostKey: room.hostKey };
  });

  on('room:hello', ({ code, secret }) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) fail('Questa stanza non esiste o è scaduta. Chiedi un nuovo link a chi l\'ha creata.');
    const player = secret ? findBySecret(room, secret) : null;
    if (player) {
      attach(room, player);
      broadcast(room);
      return { joined: true };
    }
    const canJoin = room.phase === 'lobby' && room.players.length < LIMITS.maxPlayers;
    return {
      joined: false,
      canJoin,
      reason: canJoin ? null : room.phase !== 'lobby'
        ? 'La partita in questa stanza è già iniziata.'
        : 'La stanza è piena.',
    };
  });

  on('room:join', ({ code, name, hostKey }) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) fail('Questa stanza non esiste o è scaduta.');
    if (room.phase !== 'lobby') fail('La partita in questa stanza è già iniziata.');
    if (room.players.length >= LIMITS.maxPlayers) fail('La stanza è piena.');
    const clean_name = clean(name, LIMITS.name);
    if (!clean_name) fail('Scrivi un nome per entrare.');
    if (room.players.some((p) => p.name.toLocaleLowerCase('it') === clean_name.toLocaleLowerCase('it'))) {
      fail('Questo nome è già usato in questa stanza. Scegline un altro.');
    }
    const player = {
      pid: shortId(), secret: token(), name: clean_name,
      socketId: null, connected: false, ready: false, removeTimer: null,
    };
    room.players.push(player);
    attach(room, player);
    if (hostKey && hostKey === room.hostKey && !room.hostByKey) {
      room.hostPid = player.pid;
      room.hostByKey = true;
    }
    ensureHost(room);
    broadcast(room);
    return { secret: player.secret };
  });

  on('game:start', () => {
    const { room, me } = ctx();
    requireHost(room, me);
    requirePhase(room, 'lobby');
    if (room.players.length < LIMITS.minPlayers) fail(`Servono almeno ${LIMITS.minPlayers} giocatori.`);
    startWriting(room);
    broadcast(room);
  });

  on('question:add', ({ text }) => {
    const { room, me } = ctx();
    requirePhase(room, 'writing');
    const q = clean(text, LIMITS.question);
    if (!q) fail('Scrivi una domanda prima di aggiungerla.');
    const mine = room.pool.filter((x) => x.authorPid === me.pid).length;
    if (mine >= LIMITS.questionsPerPlayer) fail(`Puoi scrivere al massimo ${LIMITS.questionsPerPlayer} domande.`);
    room.pool.push({ id: shortId(), text: q, authorPid: me.pid });
    broadcast(room);
  });

  on('question:remove', ({ id }) => {
    const { room, me } = ctx();
    requirePhase(room, 'writing');
    room.pool = room.pool.filter((q) => !(q.id === id && q.authorPid === me.pid));
    if (!room.pool.some((q) => q.authorPid === me.pid)) me.ready = false;
    broadcast(room);
  });

  on('player:ready', ({ ready }) => {
    const { room, me } = ctx();
    requirePhase(room, 'writing');
    if (ready && !room.pool.some((q) => q.authorPid === me.pid)) fail('Scrivi almeno una domanda prima di confermare.');
    me.ready = !!ready;
    maybeFinishWriting(room);
    broadcast(room);
  });

  on('writing:startNow', () => {
    const { room, me } = ctx();
    requireHost(room, me);
    requirePhase(room, 'writing');
    if (!room.pool.length) fail('Non c\'è ancora nessuna domanda.');
    startAnswering(room, Math.min(room.targetRounds, room.pool.length));
    broadcast(room);
  });

  on('answer:submit', ({ text }) => {
    const { room, me } = ctx();
    requirePhase(room, 'answering');
    const a = clean(text, LIMITS.answer);
    if (!a) fail('Scrivi una risposta prima di inviarla.');
    room.rounds[room.current].answers.set(me.pid, a);
    maybeFinishAnswer(room);
    broadcast(room);
  });

  on('guess:submit', ({ guesses }) => {
    const { room, me } = ctx();
    requirePhase(room, 'guessing');
    const r = room.rounds[room.current];
    if (!Array.isArray(guesses) || guesses.length !== r.order.length) fail('Abbina tutte le risposte prima di confermare.');
    const valid = new Set(r.order.filter((pid) => pid !== me.pid));
    const cleaned = r.order.map((author, i) => {
      if (author === me.pid) return null;
      const g = guesses[i];
      if (!valid.has(g)) fail('Abbina tutte le risposte prima di confermare.');
      return g;
    });
    r.guesses.set(me.pid, cleaned);
    maybeFinishGuess(room);
    broadcast(room);
  });

  on('host:skip', () => {
    const { room, me } = ctx();
    requireHost(room, me);
    if (room.phase === 'answering') {
      if (!room.rounds[room.current].answers.size) fail('Nessuno ha ancora risposto a questa domanda.');
      advanceAnswering(room);
    } else if (room.phase === 'guessing') {
      if (!room.rounds[room.current].guesses.size) fail('Nessuno ha ancora confermato.');
      room.phase = 'reveal';
    } else {
      fail('Questa azione non è disponibile ora.');
    }
    broadcast(room);
  });

  on('round:next', () => {
    const { room, me } = ctx();
    requireHost(room, me);
    requirePhase(room, 'reveal');
    room.current += 1;
    room.phase = room.current >= room.rounds.length ? 'results' : 'guessing';
    broadcast(room);
  });

  on('game:again', () => {
    const { room, me } = ctx();
    requireHost(room, me);
    requirePhase(room, 'results');
    room.players = room.players.filter((p) => p.connected);
    ensureHost(room);
    room.phase = 'lobby';
    room.pool = [];
    room.rounds = [];
    room.current = 0;
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    const player = playerByPid(room, socket.data.pid);
    if (!player || player.socketId !== socket.id) return;
    player.socketId = null;
    player.connected = false;
    // In sala d'attesa chi esce davvero viene tolto dopo un po'; durante la partita resta, per poter rientrare.
    if (room.phase === 'lobby') {
      player.removeTimer = setTimeout(() => {
        if (!player.connected && room.phase === 'lobby') {
          removePlayer(room, player.pid);
          broadcast(room);
        }
      }, 30_000);
    }
    broadcast(room);
  });
});

// Pulizia delle stanze inattive
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    const idle = now - room.lastActive;
    const anyoneHere = room.players.some((p) => p.connected);
    if (idle > 6 * 3600_000 || (!anyoneHere && idle > 3600_000)) rooms.delete(code);
  });
}, 10 * 60_000).unref();

server.listen(PORT, () => {
  console.log(`Chi l'ha scritto? è in ascolto su http://localhost:${PORT}`);
});
