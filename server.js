'use strict';

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const { v4: uuid } = require('uuid');
const { compareSounds, getCommentary } = require('./audioCompare');
const CELEBS   = require('./data/celebrities.json');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 20e6,  // 20 MB — audio blobs
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Helpers ────────────────────────────────────────────────────────────────
const GRACE_MS   = 5 * 60 * 1000; // 5-minute disconnect grace
const GUESS_SECS = 45;
const NOISE_RECORD_SECS = 10;   // hold-to-record max for creator
const NOISE_MIMIC_SECS  = 10;   // hold-to-record max for mimics
const MIMIC_SUBMIT_SECS = 35;   // window for all mimics to come in

function randCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }

function getCelebs(category, count = 5, exclude = []) {
  let pool;
  if (category === 'mixed') {
    pool = Object.values(CELEBS).flat();
  } else {
    pool = CELEBS[category] || Object.values(CELEBS).flat();
  }
  return shuffle(pool.filter(c => !exclude.includes(c))).slice(0, count);
}

function normalize(s) {
  return s.toLowerCase().trim()
    .replace(/[éèêë]/g,'e').replace(/[áàâä]/g,'a')
    .replace(/[íìîï]/g,'i').replace(/[óòôö]/g,'o')
    .replace(/[úùûü]/g,'u').replace(/[^a-z0-9 ]/g,'');
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({length: m+1}, (_, i) => [i]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function fuzzyMatch(guess, target) {
  const g = normalize(guess), t = normalize(target);
  if (!g) return false;
  if (g === t) return true;
  const parts = t.split(' ').filter(p => p.length > 2);
  for (const p of parts) {
    if (g === p || g.includes(p) || p.includes(g)) return true;
  }
  return levenshtein(g, t) / Math.max(g.length, t.length) < 0.35;
}

// ── Room factory ──────────────────────────────────────────────────────────
function mkRoom(code, hostId) {
  return {
    code,
    hostId,
    mode:          'reverse',  // 'reverse' | 'noise'
    roundCount:    10,
    currentRound:  0,
    phase:         'lobby',
    players:       new Map(),  // playerId → player
    speakerOrder:  [],
    speakerIdx:    0,
    // reverse-voice state
    selectedCat:      null,
    selectedCeleb:    null,
    speakerAudio:     null,
    guesses:          new Map(), // playerId → {guess,correct,points,time}
    usedCelebs:       [],
    // noise-mimic state
    creatorAudio:     null,
    mimics:           new Map(), // playerId → {audio,score,commentary}
    // timers
    phaseTimer:    null,
    phaseEndEpoch: null,
    roundResult:   null,
  };
}

function mkPlayer(id, socketId, name, isHost) {
  return { id, socketId, name, isHost, score: 0, connected: true,
           ready: false, disconnectTimer: null };
}

function snapshot(room) {
  return {
    code:          room.code,
    hostId:        room.hostId,
    mode:          room.mode,
    roundCount:    room.roundCount,
    currentRound:  room.currentRound,
    phase:         room.phase,
    players:       [...room.players.values()].map(p => ({
      id: p.id, name: p.name, score: p.score,
      connected: p.connected, ready: p.ready, isHost: p.isHost,
    })),
    speakerOrder:  room.speakerOrder,
    speakerIdx:    room.speakerIdx,
    selectedCat:   room.selectedCat,
    phaseEndEpoch: room.phaseEndEpoch,
    roundResult:   room.roundResult,
    // Send audio when guesser needs it
    speakerAudio:  ['guessing'].includes(room.phase) ? room.speakerAudio : null,
    creatorAudio:  ['noise_mimic'].includes(room.phase) ? room.creatorAudio : null,
    mimics: room.phase === 'round_result' && room.mode === 'noise'
      ? Object.fromEntries([...room.mimics.entries()].map(([id,m]) =>
          [id, { score: m.score, commentary: m.commentary, audio: m.audio }]))
      : null,
  };
}

// ── Phase helpers ─────────────────────────────────────────────────────────
const rooms = new Map();

function roomOf(socket) { return rooms.get(socket.roomCode); }

function clearPhaseTimer(room) {
  if (room.phaseTimer) { clearTimeout(room.phaseTimer); room.phaseTimer = null; }
}

function setPhaseTimer(room, ms, fn) {
  clearPhaseTimer(room);
  room.phaseEndEpoch = Date.now() + ms;
  room.phaseTimer = setTimeout(fn, ms);
}

function broadcastRoom(room) {
  io.to(room.code).emit('room_snapshot', snapshot(room));
}

function startRound(room) {
  room.currentRound++;
  room.guesses.clear();
  room.mimics.clear();
  room.speakerAudio  = null;
  room.creatorAudio  = null;
  room.selectedCeleb = null;
  room.selectedCat   = null;
  room.roundResult   = null;

  if (room.mode === 'reverse') {
    // Rotate speaker
    room.speakerIdx = (room.currentRound - 1) % room.speakerOrder.length;
    room.phase = 'speaker_cat';
    broadcastRoom(room);
    // Send speaker their private notification
    const speaker = room.players.get(room.speakerOrder[room.speakerIdx]);
    if (speaker) io.to(speaker.socketId).emit('you_are_speaker', {});
  } else {
    // Rotate noise creator
    room.speakerIdx = (room.currentRound - 1) % room.speakerOrder.length;
    room.phase = 'noise_record';
    room.phaseEndEpoch = null;
    broadcastRoom(room);
    const creator = room.players.get(room.speakerOrder[room.speakerIdx]);
    if (creator) io.to(creator.socketId).emit('you_are_creator', {});
  }
}

function endGuessing(room) {
  clearPhaseTimer(room);
  const guessers = room.speakerOrder.filter(id => id !== room.speakerOrder[room.speakerIdx]);
  const anyCorrect = [...room.guesses.values()].some(g => g.correct);

  if (!anyCorrect) {
    // Speaker stumps — +80 to speaker
    const spId = room.speakerOrder[room.speakerIdx];
    const sp = room.players.get(spId);
    if (sp) sp.score += 80;
  }

  const entries = [...room.guesses.entries()].map(([pid, g]) => ({
    playerId: pid,
    name: room.players.get(pid)?.name ?? '?',
    guess: g.guess,
    correct: g.correct,
    points: g.points,
  }));

  room.roundResult = {
    celebrity: room.selectedCeleb,
    speakerId: room.speakerOrder[room.speakerIdx],
    speakerName: room.players.get(room.speakerOrder[room.speakerIdx])?.name ?? '',
    stumped: !anyCorrect,
    guesses: entries,
    scores: [...room.players.values()].map(p => ({ id:p.id, name:p.name, score:p.score })),
  };

  room.phase = 'round_result';
  broadcastRoom(room);

  // Auto-advance after 8s unless host clicks next
  setPhaseTimer(room, 8000, () => advanceFromResult(room));
}

function finalizeMimics(room) {
  clearPhaseTimer(room);
  room.phase = 'noise_scoring';
  broadcastRoom(room);

  const creatorId = room.speakerOrder[room.speakerIdx];
  const b64Orig   = room.creatorAudio;

  // Score each mimic
  const scored = [];
  for (const [pid, mimic] of room.mimics) {
    const score      = b64Orig ? compareSounds(b64Orig, mimic.audio) : Math.floor(Math.random()*60+20);
    const commentary = getCommentary(score);
    mimic.score      = score;
    mimic.commentary = commentary;
    const player = room.players.get(pid);
    scored.push({ pid, score, name: player?.name ?? '?' });
  }

  // Sort by score desc → award points
  scored.sort((a, b) => b.score - a.score);
  const pts = [100, 60, 30];
  scored.forEach((s, i) => {
    const p = room.players.get(s.pid);
    if (p) p.score += pts[i] ?? 0;
  });

  room.roundResult = {
    creatorId,
    creatorName:  room.players.get(creatorId)?.name ?? '',
    ranking: scored.map((s, i) => ({
      rank: i + 1,
      playerId: s.pid,
      name: s.name,
      score: s.score,
      commentary: room.mimics.get(s.pid)?.commentary ?? '',
      points: pts[i] ?? 0,
    })),
    scores: [...room.players.values()].map(p => ({ id:p.id, name:p.name, score:p.score })),
  };

  room.phase = 'round_result';
  broadcastRoom(room);
  setPhaseTimer(room, 10000, () => advanceFromResult(room));
}

function advanceFromResult(room) {
  clearPhaseTimer(room);
  if (room.currentRound >= room.roundCount) {
    endGame(room);
  } else {
    startRound(room);
  }
}

function endGame(room) {
  const sorted = [...room.players.values()]
    .sort((a, b) => b.score - a.score);
  room.phase = 'final';
  room.roundResult = {
    podium: sorted.slice(0, 3).map((p, i) => ({ rank: i+1, name: p.name, score: p.score })),
    allScores: sorted.map(p => ({ id: p.id, name: p.name, score: p.score })),
  };
  broadcastRoom(room);
}

// ── Socket ────────────────────────────────────────────────────────────────
io.on('connection', socket => {

  // ── Join / Create ───────────────────────────────────────────────────────
  socket.on('create_room', ({ playerName }) => {
    const name = String(playerName || 'Player').trim().slice(0, 20);
    let code;
    do { code = randCode(); } while (rooms.has(code));

    const playerId = uuid();
    const room     = mkRoom(code, playerId);
    const player   = mkPlayer(playerId, socket.id, name, true);
    room.players.set(playerId, player);
    rooms.set(code, room);

    socket.roomCode = code;
    socket.playerId = playerId;
    socket.join(code);

    socket.emit('room_created', { playerId, room: snapshot(room) });
  });

  socket.on('join_room', ({ roomCode, playerName }) => {
    const code = String(roomCode || '').toUpperCase().trim().replace(/[^A-Z0-9]/g,'');
    const name = String(playerName || 'Player').trim().slice(0, 20);

    if (!rooms.has(code)) { socket.emit('join_error', { msg: 'Room not found.' }); return; }
    const room = rooms.get(code);
    if (room.players.size >= 8 && ![...room.players.values()].find(p => p.name === name)) {
      socket.emit('join_error', { msg: 'Room is full (max 8).' }); return;
    }
    if (room.phase !== 'lobby') {
      socket.emit('join_error', { msg: 'Game already in progress.' }); return;
    }

    const playerId = uuid();
    const player   = mkPlayer(playerId, socket.id, name, false);
    room.players.set(playerId, player);
    socket.roomCode = code;
    socket.playerId = playerId;
    socket.join(code);

    socket.emit('room_joined', { playerId, room: snapshot(room) });
    socket.to(code).emit('room_snapshot', snapshot(room));
  });

  // ── Reconnect ───────────────────────────────────────────────────────────
  socket.on('rejoin', ({ playerId, roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) { socket.emit('rejoin_failed', { msg: 'Room expired.' }); return; }

    const player = room.players.get(playerId);
    if (!player) { socket.emit('rejoin_failed', { msg: 'Session not found.' }); return; }

    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
    player.socketId = socket.id;
    player.connected = true;

    socket.roomCode = roomCode;
    socket.playerId = playerId;
    socket.join(roomCode);

    socket.emit('rejoin_success', { playerId, room: snapshot(room) });
    socket.to(roomCode).emit('player_reconnected', { playerId, name: player.name });
    broadcastRoom(room);

    // Re-send private role notification if mid-round
    if (['speaker_cat','speaker_celeb','speaker_record'].includes(room.phase)) {
      if (room.speakerOrder[room.speakerIdx] === playerId)
        socket.emit('you_are_speaker', {});
    }
    if (room.phase === 'noise_record') {
      if (room.speakerOrder[room.speakerIdx] === playerId)
        socket.emit('you_are_creator', {});
    }
    if (room.phase === 'guessing' && room.speakerAudio) {
      socket.emit('reversed_audio', { audioBase64: room.speakerAudio });
    }
    if (room.phase === 'noise_mimic' && room.creatorAudio) {
      socket.emit('creator_audio', { audioBase64: room.creatorAudio });
    }
  });

  // ── Lobby controls ──────────────────────────────────────────────────────
  socket.on('set_ready', ({ ready }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'lobby') return;
    const p = room.players.get(socket.playerId);
    if (!p) return;
    p.ready = !!ready;
    broadcastRoom(room);
  });

  socket.on('host_set_mode', ({ mode }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'lobby' || room.hostId !== socket.playerId) return;
    if (['reverse','noise'].includes(mode)) { room.mode = mode; broadcastRoom(room); }
  });

  socket.on('host_set_rounds', ({ count }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'lobby' || room.hostId !== socket.playerId) return;
    const n = parseInt(count, 10);
    if (n >= 2 && n <= 20) { room.roundCount = n; broadcastRoom(room); }
  });

  socket.on('host_start', () => {
    const room = roomOf(socket);
    if (!room || room.hostId !== socket.playerId) return;
    if (room.players.size < 2) {
      socket.emit('error_msg', { msg: 'Need at least 2 players.' }); return;
    }
    room.speakerOrder = shuffle([...room.players.keys()]);
    room.currentRound = 0;
    startRound(room);
  });

  // ── Mode 1 — Reverse Voice ──────────────────────────────────────────────
  socket.on('select_category', ({ category }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'speaker_cat') return;
    if (room.speakerOrder[room.speakerIdx] !== socket.playerId) return;
    const valid = ['footballers','singers','actors','internet','mixed'];
    if (!valid.includes(category)) return;

    room.selectedCat = category;
    const options    = getCelebs(category, 5, room.usedCelebs);
    room.phase       = 'speaker_celeb';
    broadcastRoom(room);
    socket.emit('celeb_options', { options });
  });

  socket.on('select_celeb', ({ celeb }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'speaker_celeb') return;
    if (room.speakerOrder[room.speakerIdx] !== socket.playerId) return;

    room.selectedCeleb = celeb;
    room.usedCelebs.push(celeb);
    room.phase = 'speaker_record';
    broadcastRoom(room);
    socket.emit('celeb_confirmed', { celeb });
  });

  socket.on('speaker_audio', ({ audioBase64 }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'speaker_record') return;
    if (room.speakerOrder[room.speakerIdx] !== socket.playerId) return;

    room.speakerAudio = audioBase64;
    room.phase        = 'guessing';
    broadcastRoom(room);

    // Send reversed audio to all non-speakers
    const spId = socket.playerId;
    for (const p of room.players.values()) {
      if (p.id !== spId && p.connected) {
        io.to(p.socketId).emit('reversed_audio', { audioBase64 });
      }
    }

    // 45-second guess window
    setPhaseTimer(room, GUESS_SECS * 1000, () => endGuessing(room));
  });

  socket.on('submit_guess', ({ guess }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'guessing') return;
    if (room.speakerOrder[room.speakerIdx] === socket.playerId) return;
    if (room.guesses.has(socket.playerId)) return;

    const player      = room.players.get(socket.playerId);
    if (!player) return;
    const correct     = fuzzyMatch(guess, room.selectedCeleb);
    const firstCorrect = correct && ![...room.guesses.values()].some(g => g.correct);
    const points      = correct ? (firstCorrect ? 100 : 60) : 0;
    if (points) player.score += points;

    room.guesses.set(socket.playerId, { guess, correct, points, time: Date.now() });
    io.to(room.code).emit('guess_in', {
      playerId: socket.playerId, name: player.name,
      correct, firstCorrect, points,
    });

    // All guessers submitted?
    const numGuessers = room.speakerOrder.length - 1;
    if (room.guesses.size >= numGuessers) endGuessing(room);
  });

  // ── Mode 2 — Noise Mimic ───────────────────────────────────────────────
  socket.on('creator_audio', ({ audioBase64 }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'noise_record') return;
    if (room.speakerOrder[room.speakerIdx] !== socket.playerId) return;

    room.creatorAudio = audioBase64;
    room.phase        = 'noise_mimic';
    broadcastRoom(room);

    // Send to all non-creators
    const crId = socket.playerId;
    for (const p of room.players.values()) {
      if (p.id !== crId && p.connected) {
        io.to(p.socketId).emit('creator_audio', { audioBase64 });
      }
    }

    setPhaseTimer(room, MIMIC_SUBMIT_SECS * 1000, () => finalizeMimics(room));
  });

  socket.on('mimic_audio', ({ audioBase64 }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'noise_mimic') return;
    if (room.speakerOrder[room.speakerIdx] === socket.playerId) return;
    if (room.mimics.has(socket.playerId)) return;

    room.mimics.set(socket.playerId, { audio: audioBase64, score: 0, commentary: '' });
    io.to(room.code).emit('mimic_in', { playerId: socket.playerId,
      name: room.players.get(socket.playerId)?.name ?? '?' });

    // All mimics in?
    const expected = room.speakerOrder.length - 1;
    if (room.mimics.size >= expected) finalizeMimics(room);
  });

  // ── Round navigation ───────────────────────────────────────────────────
  socket.on('next_round', () => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'round_result') return;
    if (room.hostId !== socket.playerId) return;
    clearPhaseTimer(room);
    advanceFromResult(room);
  });

  socket.on('play_again', () => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'final') return;
    if (room.hostId !== socket.playerId) return;
    // Reset scores
    for (const p of room.players.values()) { p.score = 0; p.ready = false; }
    room.currentRound = 0;
    room.usedCelebs   = [];
    room.speakerOrder = shuffle([...room.players.keys()]);
    startRound(room);
  });

  socket.on('back_to_lobby', () => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'final') return;
    if (room.hostId !== socket.playerId) return;
    for (const p of room.players.values()) { p.score = 0; p.ready = false; }
    room.currentRound = 0;
    room.usedCelebs   = [];
    room.phase        = 'lobby';
    clearPhaseTimer(room);
    broadcastRoom(room);
  });

  // ── Disconnect ─────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const room = roomOf(socket);
    if (!room) return;
    const player = room.players.get(socket.playerId);
    if (!player) return;
    player.connected = false;
    socket.to(room.code).emit('player_disconnected', { playerId: player.id, name: player.name });
    broadcastRoom(room);

    player.disconnectTimer = setTimeout(() => {
      room.players.delete(player.id);
      if (room.players.size === 0) { rooms.delete(room.code); return; }
      // Re-assign host if needed
      if (room.hostId === player.id) {
        const next = room.players.values().next().value;
        if (next) { next.isHost = true; room.hostId = next.id; }
      }
      broadcastRoom(room);
    }, GRACE_MS);
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`EchoClash listening on :${PORT}`));
