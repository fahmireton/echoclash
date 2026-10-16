'use strict';

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const { v4: uuid } = require('uuid');
const { compareSounds, getCommentary } = require('./audioCompare');
const CELEBS        = require('./data/celebrities.json');
const WORD_PAIRS_RAW  = require('./data/word_pairs.json');
const WORD_PAIRS_FLAT = Object.values(WORD_PAIRS_RAW).flat();

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 20e6,
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Constants ──────────────────────────────────────────────────────────────
const GRACE_MS              = 5 * 60 * 1000;
const GUESS_SECS            = 45;
const NOISE_RECORD_SECS     = 5;
const NOISE_MIMIC_SECS      = 5;
const MIMIC_SUBMIT_SECS     = 35;
const IMPOSTER_VOTE_SECS    = 40;
const TELEPHONE_REVEAL_SECS = 30;
const TELEPHONE_VOTE_SECS   = 30;
const WI_REVEAL_SECS  = 30;
const WI_CLUE_SECS    = 30;
const WI_DISCUSS_SECS = 90;
const WI_VOTE_SECS    = 35;
const WI_GUESS_SECS   = 20;

// ── Content pools ──────────────────────────────────────────────────────────
const IMPOSTER_PROMPTS = [
  "The fuzzy caterpillar ate seventeen pancakes before sunrise",
  "I secretly replaced all the chairs with inflatable flamingos",
  "My neighbour's hamster knows how to operate a blender",
  "The mayor decided to tax all left-handed pasta",
  "A suspicious pigeon stole my library card and three stamps",
  "Grandma keeps her socks in the microwave for warmth",
  "The local dentist moonlights as a professional cheese sculptor",
  "We found a submarine in the school swimming pool",
  "My alarm clock only wakes me up when it feels like it",
  "Three invisible geese were spotted arguing outside the post office",
  "He insisted the moon was made of forgotten birthday cakes",
  "The supermarket replaced all trolleys with electric scooters",
];

const TELEPHONE_PHRASES = [
  "Crispy purple dinosaur dancing at midnight",
  "My uncle sold twelve umbrellas to a confused penguin",
  "The robot chef burned every meal except the ice cream",
  "Seven tiny clouds floated through the living room window",
  "A polite shark apologised and returned the stolen surfboard",
  "Grandmother's secret ingredient is exactly four rubber bands",
  "The invisible man forgot where he parked his bicycle",
  "Forty-two monkeys organised a peaceful protest outside the library",
  "The suspicious mailman only delivers letters on leap years",
  "Whoever invented glitter should be held accountable by law",
  "Professor Biscuit declared Tuesdays illegal for most vegetables",
  "A raccoon stole my passport and opened a small café",
];

const IMPOSTER_EFFECTS = ['helium', 'demon', 'robot', 'walkie'];

function randItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── Helpers ────────────────────────────────────────────────────────────────
function randCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }

function getCelebs(category, count = 5, exclude = []) {
  let pool;
  if (category === 'mixed') pool = Object.values(CELEBS).flat();
  else pool = CELEBS[category] || Object.values(CELEBS).flat();
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

// ── Name hint (progressive letter reveal for Mode 1) ──────────────────────
function seededShuffle(arr, seed) {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const j = Math.abs(s) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function computeNameHint(name, timeLeftMs) {
  const timeLeft = timeLeftMs / 1000;
  const letters = [];
  for (let i = 0; i < name.length; i++) {
    if (/[a-zA-Z]/.test(name[i])) letters.push(i);
  }
  if (timeLeft > 30) return name.split('').map(c => /[a-zA-Z]/.test(c) ? '_' : c).join('');
  const progress = Math.max(0, (30 - timeLeft) / 30);
  const revealCount = Math.min(letters.length, Math.floor(progress * 0.4 * letters.length + 0.5));
  const seed = name.split('').reduce((a, c, i) => a + c.charCodeAt(0) * (i + 1), 0);
  const shuffled = seededShuffle(letters, seed);
  const revealed = new Set(shuffled.slice(0, revealCount));
  return name.split('').map((c, i) => /[a-zA-Z]/.test(c) ? (revealed.has(i) ? c : '_') : c).join('');
}

// ── Room factory ──────────────────────────────────────────────────────────
function mkRoom(code, hostId) {
  return {
    code, hostId,
    mode: 'reverse',  // 'reverse' | 'noise' | 'imposter' | 'telephone'
    roundCount: 10,
    currentRound: 0,
    phase: 'lobby',
    players: new Map(),
    speakerOrder: [],
    speakerIdx: 0,
    // Mode 1 — Reverse Voice
    selectedCat: null, selectedCeleb: null, speakerAudio: null,
    guesses: new Map(), usedCelebs: [],
    // Mode 2 — Noise Mimic
    creatorAudio: null, mimics: new Map(),
    // Mode 3 — Voice Disguise
    imposterId: null, imposterPrompt: null, imposterEffect: null,
    imposterAudio: null, votes: new Map(),
    // Mode 4 — Broken Telephone
    telephoneChain: [], telephoneCurrentIdx: 0,
    telephonePrompt: null, telephoneRecordings: [],
    telephoneVotesAccurate: new Map(), telephoneVotesBlunder: new Map(),
    // Mode 5 — Word Imposter
    wiImpostorCount: 1, wiUndercoverMode: false,
    wiCivilianWord: null, wiImposterWord: null,
    wiAssignments: new Map(), wiWords: new Map(),
    wiClueOrder: [], wiCurrentClueIdx: 0,
    wiClues: new Map(), wiVotes: new Map(),
    wiEliminated: [], wiCycleCount: 0, wiMaxCycles: 3,
    // Timers
    phaseTimer: null, phaseEndEpoch: null, roundResult: null, hintInterval: null,
  };
}

function mkPlayer(id, socketId, name, isHost) {
  return { id, socketId, name, isHost, score: 0, connected: true, ready: false, disconnectTimer: null };
}

function snapshot(room) {
  return {
    code: room.code, hostId: room.hostId, mode: room.mode,
    roundCount: room.roundCount, currentRound: room.currentRound, phase: room.phase,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, score: p.score,
      connected: p.connected, ready: p.ready, isHost: p.isHost,
    })),
    speakerOrder: room.speakerOrder, speakerIdx: room.speakerIdx,
    selectedCat: room.selectedCat, phaseEndEpoch: room.phaseEndEpoch, roundResult: room.roundResult,
    // Mode 1
    speakerAudio: room.phase === 'guessing' ? room.speakerAudio : null,
    // Mode 2
    creatorAudio: room.phase === 'noise_mimic' ? room.creatorAudio : null,
    mimics: room.phase === 'round_result' && room.mode === 'noise'
      ? Object.fromEntries([...room.mimics.entries()].map(([id,m]) =>
          [id, { score: m.score, commentary: m.commentary, audio: m.audio }]))
      : null,
    // Mode 3
    imposterAudio: room.phase === 'imposter_vote' ? room.imposterAudio : null,
    imposterEffect: ['imposter_vote','round_result'].includes(room.phase) ? room.imposterEffect : null,
    imposterId: room.phase === 'round_result' && room.mode === 'imposter' ? room.imposterId : null,
    votesIn: room.phase === 'imposter_vote' ? room.votes.size : null,
    // Mode 4
    telephoneChain: room.telephoneChain,
    telephoneCurrentIdx: room.telephoneCurrentIdx,
    telephoneRecordings: ['telephone_reveal','telephone_vote','round_result'].includes(room.phase) && room.mode === 'telephone'
      ? room.telephoneRecordings.map(r => ({ pid: r.pid, name: r.name, audio: r.audio }))
      : room.telephoneRecordings.map(r => ({ pid: r.pid, name: r.name })),
    telephonePrompt: ['telephone_reveal','telephone_vote','round_result'].includes(room.phase)
      ? room.telephonePrompt : null,
    telephoneVotesAccurateIn: room.phase === 'telephone_vote' ? room.telephoneVotesAccurate.size : null,
    telephoneVotesBlunderIn:  room.phase === 'telephone_vote' ? room.telephoneVotesBlunder.size  : null,
    // Mode 5
    wiImpostorCount: room.wiImpostorCount,
    wiUndercoverMode: room.wiUndercoverMode,
    wiClueOrder: room.wiClueOrder,
    wiCurrentClueIdx: room.wiCurrentClueIdx,
    wiClues: Object.fromEntries(room.wiClues || []),
    wiVotesIn: room.phase === 'wi_vote' ? room.wiVotes.size : null,
    wiEliminated: room.wiEliminated || [],
    wiCycleCount: room.wiCycleCount || 0,
  };
}

// ── Phase helpers ─────────────────────────────────────────────────────────
const rooms = new Map();

function roomOf(socket) { return rooms.get(socket.roomCode); }

function clearPhaseTimer(room) {
  if (room.phaseTimer)  { clearTimeout(room.phaseTimer);   room.phaseTimer  = null; }
  if (room.hintInterval){ clearInterval(room.hintInterval); room.hintInterval = null; }
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
  room.guesses.clear(); room.mimics.clear(); room.votes.clear();
  room.speakerAudio = null; room.creatorAudio = null;
  room.selectedCeleb = null; room.selectedCat = null; room.roundResult = null;
  room.imposterId = null; room.imposterPrompt = null; room.imposterEffect = null; room.imposterAudio = null;
  room.telephoneCurrentIdx = 0; room.telephoneRecordings = []; room.telephonePrompt = null;
  room.telephoneVotesAccurate.clear(); room.telephoneVotesBlunder.clear();
  room.wiAssignments.clear(); room.wiWords.clear(); room.wiClues.clear(); room.wiVotes.clear();
  room.wiEliminated = []; room.wiCycleCount = 0; room.wiCurrentClueIdx = 0; room.wiClueOrder = [];
  room.wiCivilianWord = null; room.wiImposterWord = null;

  if (room.mode === 'reverse') {
    room.speakerIdx = (room.currentRound - 1) % room.speakerOrder.length;
    room.phase = 'speaker_cat';
    broadcastRoom(room);
    const speaker = room.players.get(room.speakerOrder[room.speakerIdx]);
    if (speaker) io.to(speaker.socketId).emit('you_are_speaker', {});

  } else if (room.mode === 'noise') {
    room.speakerIdx = (room.currentRound - 1) % room.speakerOrder.length;
    room.phase = 'noise_record';
    room.phaseEndEpoch = null;
    broadcastRoom(room);
    const creator = room.players.get(room.speakerOrder[room.speakerIdx]);
    if (creator) io.to(creator.socketId).emit('you_are_creator', {});

  } else if (room.mode === 'imposter') {
    room.speakerIdx = (room.currentRound - 1) % room.speakerOrder.length;
    room.imposterId = room.speakerOrder[room.speakerIdx];
    room.imposterPrompt = randItem(IMPOSTER_PROMPTS);
    room.imposterEffect = randItem(IMPOSTER_EFFECTS);
    room.phase = 'imposter_record';
    broadcastRoom(room);
    const imposter = room.players.get(room.imposterId);
    if (imposter) io.to(imposter.socketId).emit('you_are_imposter', {
      prompt: room.imposterPrompt, effect: room.imposterEffect,
    });

  } else if (room.mode === 'word_imposter') {
    startWiGame(room);

  } else if (room.mode === 'telephone') {
    room.telephoneChain = [...room.speakerOrder];
    room.telephonePrompt = randItem(TELEPHONE_PHRASES);
    room.telephoneCurrentIdx = 0;
    room.phase = 'telephone_chain';
    broadcastRoom(room);
    const first = room.players.get(room.telephoneChain[0]);
    if (first) io.to(first.socketId).emit('telephone_prompt', {
      prompt: room.telephonePrompt, chainIdx: 0, chainLength: room.telephoneChain.length,
    });
  }
}

// ── Mode 1 helpers ─────────────────────────────────────────────────────────
function endGuessing(room) {
  clearPhaseTimer(room);
  const anyCorrect = [...room.guesses.values()].some(g => g.correct);
  if (!anyCorrect) {
    const sp = room.players.get(room.speakerOrder[room.speakerIdx]);
    if (sp) sp.score += 80;
  }
  const entries = [...room.guesses.entries()].map(([pid, g]) => ({
    playerId: pid, name: room.players.get(pid)?.name ?? '?',
    guess: g.guess, correct: g.correct, points: g.points,
  }));
  room.roundResult = {
    celebrity: room.selectedCeleb,
    speakerId: room.speakerOrder[room.speakerIdx],
    speakerName: room.players.get(room.speakerOrder[room.speakerIdx])?.name ?? '',
    stumped: !anyCorrect, guesses: entries,
    scores: [...room.players.values()].map(p => ({ id:p.id, name:p.name, score:p.score })),
  };
  room.phase = 'round_result';
  broadcastRoom(room);
  setPhaseTimer(room, 8000, () => advanceFromResult(room));
}

// ── Mode 2 helpers ─────────────────────────────────────────────────────────
function finalizeMimics(room) {
  clearPhaseTimer(room);
  room.phase = 'noise_scoring';
  broadcastRoom(room);
  const creatorId = room.speakerOrder[room.speakerIdx];
  const b64Orig   = room.creatorAudio;
  const scored = [];
  for (const [pid, mimic] of room.mimics) {
    const score      = b64Orig ? compareSounds(b64Orig, mimic.audio) : Math.floor(Math.random()*60+20);
    const commentary = getCommentary(score);
    mimic.score = score; mimic.commentary = commentary;
    scored.push({ pid, score, name: room.players.get(pid)?.name ?? '?' });
  }
  scored.sort((a, b) => b.score - a.score);
  scored.forEach(s => { const p = room.players.get(s.pid); if (p) p.score += s.score; });
  room.roundResult = {
    creatorId, creatorName: room.players.get(creatorId)?.name ?? '',
    ranking: scored.map((s, i) => ({
      rank: i+1, playerId: s.pid, name: s.name, score: s.score,
      commentary: room.mimics.get(s.pid)?.commentary ?? '', points: s.score,
    })),
    scores: [...room.players.values()].map(p => ({ id:p.id, name:p.name, score:p.score })),
  };
  room.phase = 'round_result';
  broadcastRoom(room);
  setPhaseTimer(room, 10000, () => advanceFromResult(room));
}

// ── Mode 3 helpers ─────────────────────────────────────────────────────────
function finalizeImposterVote(room) {
  clearPhaseTimer(room);
  const voteCount = new Map();
  for (const tid of room.votes.values())
    voteCount.set(tid, (voteCount.get(tid) || 0) + 1);
  const totalVotes = room.votes.size;
  const votesAgainst = voteCount.get(room.imposterId) || 0;
  const caught = totalVotes > 0 && votesAgainst > totalVotes / 2;
  const imposter = room.players.get(room.imposterId);
  if (!caught && imposter) imposter.score += 100;
  for (const [vid, tid] of room.votes) {
    if (tid === room.imposterId) { const p = room.players.get(vid); if (p) p.score += 75; }
  }
  const voteList = [...room.votes.entries()].map(([vid, tid]) => ({
    voterId: vid, voterName: room.players.get(vid)?.name ?? '?',
    targetId: tid, targetName: room.players.get(tid)?.name ?? '?',
  }));
  room.roundResult = {
    imposterId: room.imposterId, imposterName: imposter?.name ?? '?',
    imposterCaught: caught, prompt: room.imposterPrompt, effect: room.imposterEffect,
    voteList, voteCount: Object.fromEntries(voteCount),
    scores: [...room.players.values()].map(p => ({ id:p.id, name:p.name, score:p.score })),
  };
  room.phase = 'round_result';
  broadcastRoom(room);
  setPhaseTimer(room, 10000, () => advanceFromResult(room));
}

// ── Mode 4 helpers ─────────────────────────────────────────────────────────
function finalizeTelephone(room) {
  clearPhaseTimer(room);
  room.phase = 'telephone_reveal';
  broadcastRoom(room);
  setPhaseTimer(room, TELEPHONE_REVEAL_SECS * 1000, () => {
    room.phase = 'telephone_vote';
    broadcastRoom(room);
    setPhaseTimer(room, TELEPHONE_VOTE_SECS * 1000, () => finalizeTelephoneVote(room));
  });
}

function finalizeTelephoneVote(room) {
  clearPhaseTimer(room);
  const accCount = new Map(), blnCount = new Map();
  for (const pid of room.telephoneVotesAccurate.values())
    accCount.set(pid, (accCount.get(pid) || 0) + 1);
  for (const pid of room.telephoneVotesBlunder.values())
    blnCount.set(pid, (blnCount.get(pid) || 0) + 1);

  let mostAccPid = null, maxAcc = 0;
  for (const [pid, n] of accCount) if (n > maxAcc) { maxAcc = n; mostAccPid = pid; }
  let blunderPid = null, maxBln = 0;
  for (const [pid, n] of blnCount) if (n > maxBln) { maxBln = n; blunderPid = pid; }

  if (mostAccPid) { const p = room.players.get(mostAccPid); if (p) p.score += 50; }
  if (blunderPid) { const p = room.players.get(blunderPid); if (p) p.score += 25; }

  room.roundResult = {
    originalPhrase: room.telephonePrompt,
    chain: room.telephoneRecordings.map(r => ({ pid: r.pid, name: r.name })),
    mostAccPid, mostAccName: mostAccPid ? room.players.get(mostAccPid)?.name : null,
    blunderPid, blunderName: blunderPid ? room.players.get(blunderPid)?.name : null,
    scores: [...room.players.values()].map(p => ({ id:p.id, name:p.name, score:p.score })),
  };
  room.phase = 'round_result';
  broadcastRoom(room);
  setPhaseTimer(room, 10000, () => advanceFromResult(room));
}

// ── Mode 5 helpers ─────────────────────────────────────────────
function startWiGame(room) {
  const pair = randItem(WORD_PAIRS_FLAT);
  room.wiCivilianWord = pair[0];
  room.wiImposterWord = pair[1];

  const pids = shuffle([...room.players.keys()]);
  const numImpostors = Math.min(room.wiImpostorCount, Math.max(1, Math.floor(pids.length / 3)));
  room.wiAssignments.clear(); room.wiWords.clear();
  room.wiMaxCycles = Math.max(2, pids.length - 2);

  let blankAssigned = false;
  for (let i = 0; i < pids.length; i++) {
    const pid = pids[i];
    if (i < numImpostors) {
      room.wiAssignments.set(pid, 'imposter');
      room.wiWords.set(pid, room.wiImposterWord);
    } else if (room.wiUndercoverMode && !blankAssigned) {
      room.wiAssignments.set(pid, 'blank');
      room.wiWords.set(pid, '');
      blankAssigned = true;
    } else {
      room.wiAssignments.set(pid, 'civilian');
      room.wiWords.set(pid, room.wiCivilianWord);
    }
  }

  room.phase = 'wi_reveal';
  broadcastRoom(room);
  for (const [pid, role] of room.wiAssignments) {
    const player = room.players.get(pid);
    if (player && player.connected) {
      io.to(player.socketId).emit('wi_role', { role, word: room.wiWords.get(pid) });
    }
  }
  setPhaseTimer(room, WI_REVEAL_SECS * 1000, () => startWiClueCycle(room));
}

function startWiClueCycle(room) {
  clearPhaseTimer(room);
  room.wiClues.clear(); room.wiVotes.clear(); room.wiCurrentClueIdx = 0;
  room.wiCycleCount++;
  const alivePids = [...room.players.keys()].filter(pid => !room.wiEliminated.some(e => e.pid === pid));
  room.wiClueOrder = shuffle(alivePids);
  room.phase = 'wi_clue';
  broadcastRoom(room);
  advanceWiClue(room);
}

function advanceWiClue(room) {
  if (room.wiCurrentClueIdx >= room.wiClueOrder.length) {
    startWiDiscuss(room); return;
  }
  broadcastRoom(room);
  const pid = room.wiClueOrder[room.wiCurrentClueIdx];
  const player = room.players.get(pid);
  if (player && player.connected) {
    io.to(player.socketId).emit('wi_your_turn', { clueIdx: room.wiCurrentClueIdx });
  }
  setPhaseTimer(room, WI_CLUE_SECS * 1000, () => {
    if (!room.wiClues.has(pid)) room.wiClues.set(pid, '…');
    room.wiCurrentClueIdx++;
    advanceWiClue(room);
  });
}

function startWiDiscuss(room) {
  clearPhaseTimer(room);
  room.phase = 'wi_discuss';
  broadcastRoom(room);
  setPhaseTimer(room, WI_DISCUSS_SECS * 1000, () => startWiVote(room));
}

function startWiVote(room) {
  clearPhaseTimer(room);
  room.wiVotes.clear();
  room.phase = 'wi_vote';
  broadcastRoom(room);
  setPhaseTimer(room, WI_VOTE_SECS * 1000, () => finalizeWiVote(room));
}

function finalizeWiVote(room) {
  clearPhaseTimer(room);
  const tally = new Map();
  for (const tid of room.wiVotes.values()) tally.set(tid, (tally.get(tid) || 0) + 1);

  let maxVotes = 0, eliminatedPid = null;
  for (const [pid, n] of tally) if (n > maxVotes) { maxVotes = n; eliminatedPid = pid; }

  if (eliminatedPid) {
    const eliminatedPlayer = room.players.get(eliminatedPid);
    const eliminatedRole   = room.wiAssignments.get(eliminatedPid);
    room.wiEliminated.push({
      pid: eliminatedPid,
      name: eliminatedPlayer?.name || '?',
      role: eliminatedRole,
      word: room.wiWords.get(eliminatedPid),
    });
    for (const [voterPid, targetPid] of room.wiVotes) {
      if (targetPid === eliminatedPid && eliminatedRole === 'imposter') {
        const voter = room.players.get(voterPid);
        if (voter) voter.score += 50;
      }
    }
  }

  const winner = checkWiWin(room);
  if (winner) { endWiGame(room, winner); return; }
  startWiClueCycle(room);
}

function checkWiWin(room) {
  const alivePids = [...room.players.keys()].filter(pid => !room.wiEliminated.some(e => e.pid === pid));
  const aliveImpostors = alivePids.filter(pid => room.wiAssignments.get(pid) === 'imposter');
  const aliveCivs      = alivePids.filter(pid => room.wiAssignments.get(pid) !== 'imposter');
  if (aliveImpostors.length === 0) return 'civilian';
  if (aliveImpostors.length >= aliveCivs.length) return 'imposter';
  if (room.wiCycleCount >= room.wiMaxCycles) return 'imposter';
  return null;
}

function endWiGame(room, winner) {
  clearPhaseTimer(room);
  if (winner === 'imposter') {
    const alivePids = [...room.players.keys()].filter(pid => !room.wiEliminated.some(e => e.pid === pid));
    for (const pid of alivePids) {
      if (room.wiAssignments.get(pid) === 'imposter') {
        const p = room.players.get(pid);
        if (p) p.score += 100;
        if (p && p.connected) io.to(p.socketId).emit('wi_guess_prompt', {});
      }
    }
    room.phase = 'wi_guess';
    broadcastRoom(room);
    setPhaseTimer(room, WI_GUESS_SECS * 1000, () => finalizeWiGame(room, winner, false));
    return;
  }
  finalizeWiGame(room, winner, false);
}

function finalizeWiGame(room, winner, imposterGuessedCorrectly) {
  clearPhaseTimer(room);
  const assignments = [];
  for (const [pid, role] of room.wiAssignments) {
    const p = room.players.get(pid);
    assignments.push({ pid, name: p?.name || '?', role, word: room.wiWords.get(pid) || '' });
  }
  room.roundResult = {
    winner, civilianWord: room.wiCivilianWord, imposterWord: room.wiImposterWord,
    assignments, eliminated: room.wiEliminated, imposterGuessedCorrectly,
    scores: [...room.players.values()].map(p => ({ id: p.id, name: p.name, score: p.score })),
  };
  room.phase = 'round_result';
  broadcastRoom(room);
  setPhaseTimer(room, 12000, () => advanceFromResult(room));
}

function advanceFromResult(room) {
  clearPhaseTimer(room);
  if (room.currentRound >= room.roundCount) endGame(room);
  else startRound(room);
}

function endGame(room) {
  const sorted = [...room.players.values()].sort((a, b) => b.score - a.score);
  room.phase = 'final';
  room.roundResult = {
    podium: sorted.slice(0, 3).map((p, i) => ({ rank: i+1, name: p.name, score: p.score })),
    allScores: sorted.map(p => ({ id: p.id, name: p.name, score: p.score })),
  };
  broadcastRoom(room);
}

// ── Socket ────────────────────────────────────────────────────────────────
io.on('connection', socket => {

  // ── Join / Create ──────────────────────────────────────────────────────
  socket.on('create_room', ({ playerName }) => {
    const name = String(playerName || 'Player').trim().slice(0, 20);
    let code;
    do { code = randCode(); } while (rooms.has(code));
    const playerId = uuid();
    const room     = mkRoom(code, playerId);
    const player   = mkPlayer(playerId, socket.id, name, true);
    room.players.set(playerId, player);
    rooms.set(code, room);
    socket.roomCode = code; socket.playerId = playerId;
    socket.join(code);
    socket.emit('room_created', { playerId, room: snapshot(room) });
  });

  socket.on('join_room', ({ roomCode, playerName }) => {
    const code = String(roomCode || '').toUpperCase().trim().replace(/[^A-Z0-9]/g,'');
    const name = String(playerName || 'Player').trim().slice(0, 20);
    if (!rooms.has(code)) { socket.emit('join_error', { msg: 'Room not found.' }); return; }
    const room = rooms.get(code);
    if (room.players.size >= 8) { socket.emit('join_error', { msg: 'Room is full (max 8).' }); return; }
    if (room.phase !== 'lobby') { socket.emit('join_error', { msg: 'Game already in progress.' }); return; }
    const playerId = uuid();
    const player   = mkPlayer(playerId, socket.id, name, false);
    room.players.set(playerId, player);
    socket.roomCode = code; socket.playerId = playerId;
    socket.join(code);
    socket.emit('room_joined', { playerId, room: snapshot(room) });
    socket.to(code).emit('room_snapshot', snapshot(room));
  });

  // ── Reconnect ──────────────────────────────────────────────────────────
  socket.on('rejoin', ({ playerId, roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) { socket.emit('rejoin_failed', { msg: 'Room expired.' }); return; }
    const player = room.players.get(playerId);
    if (!player) { socket.emit('rejoin_failed', { msg: 'Session not found.' }); return; }

    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
    player.socketId = socket.id;
    player.connected = true;
    socket.roomCode = roomCode; socket.playerId = playerId;
    socket.join(roomCode);

    socket.emit('rejoin_success', { playerId, room: snapshot(room) });
    socket.to(roomCode).emit('player_reconnected', { playerId, name: player.name });
    broadcastRoom(room);

    // Re-send private role events
    if (['speaker_cat','speaker_celeb','speaker_record'].includes(room.phase)) {
      if (room.speakerOrder[room.speakerIdx] === playerId) socket.emit('you_are_speaker', {});
    }
    if (room.phase === 'noise_record' && room.speakerOrder[room.speakerIdx] === playerId)
      socket.emit('you_are_creator', {});
    if (room.phase === 'guessing' && room.speakerAudio)
      socket.emit('reversed_audio', { audioBase64: room.speakerAudio });
    if (room.phase === 'noise_mimic' && room.creatorAudio)
      socket.emit('creator_audio', { audioBase64: room.creatorAudio });
    if (room.phase === 'imposter_record' && room.imposterId === playerId)
      socket.emit('you_are_imposter', { prompt: room.imposterPrompt, effect: room.imposterEffect });
    if (room.phase === 'imposter_vote' && room.imposterAudio)
      socket.emit('imposter_audio_relay', { audioBase64: room.imposterAudio, effect: room.imposterEffect });
    if (['wi_reveal','wi_clue','wi_discuss','wi_vote','wi_guess'].includes(room.phase)) {
      if (room.wiAssignments.has(playerId)) {
        socket.emit('wi_role', { role: room.wiAssignments.get(playerId), word: room.wiWords.get(playerId) });
      }
      if (room.phase === 'wi_clue' && room.wiClueOrder[room.wiCurrentClueIdx] === playerId) {
        socket.emit('wi_your_turn', { clueIdx: room.wiCurrentClueIdx });
      }
    }
    if (room.phase === 'telephone_chain') {
      const myIdx = room.telephoneChain.indexOf(playerId);
      if (myIdx === room.telephoneCurrentIdx) {
        if (myIdx === 0) {
          socket.emit('telephone_prompt', { prompt: room.telephonePrompt, chainIdx: 0, chainLength: room.telephoneChain.length });
        } else if (room.telephoneRecordings[myIdx - 1]) {
          socket.emit('telephone_listen', {
            audioBase64: room.telephoneRecordings[myIdx - 1].audio,
            chainIdx: myIdx, chainLength: room.telephoneChain.length,
          });
        }
      }
    }
  });

  // ── Lobby controls ─────────────────────────────────────────────────────
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
    if (['reverse','noise','imposter','telephone','word_imposter'].includes(mode)) { room.mode = mode; broadcastRoom(room); }
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
    if (room.players.size < 2) { socket.emit('error_msg', { msg: 'Need at least 2 players.' }); return; }
    room.speakerOrder = shuffle([...room.players.keys()]);
    room.currentRound = 0;
    startRound(room);
  });

  // ── Mode 1 — Reverse Voice ─────────────────────────────────────────────
  socket.on('select_category', ({ category }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'speaker_cat') return;
    if (room.speakerOrder[room.speakerIdx] !== socket.playerId) return;
    const valid = ['footballers','singers','actors','internet','mixed'];
    if (!valid.includes(category)) return;
    room.selectedCat = category;
    const options = getCelebs(category, 5, room.usedCelebs);
    room.phase = 'speaker_celeb';
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
    room.phase = 'guessing';
    broadcastRoom(room);
    const spId = socket.playerId;
    for (const p of room.players.values()) {
      if (p.id !== spId && p.connected) io.to(p.socketId).emit('reversed_audio', { audioBase64 });
    }
    setPhaseTimer(room, GUESS_SECS * 1000, () => endGuessing(room));
    // Progressive letter hint every second once timer < 30s
    room.hintInterval = setInterval(() => {
      if (room.phase !== 'guessing') { clearInterval(room.hintInterval); room.hintInterval = null; return; }
      const timeLeft = Math.max(0, room.phaseEndEpoch - Date.now());
      io.to(room.code).emit('name_hint', { hint: computeNameHint(room.selectedCeleb, timeLeft) });
    }, 1000);
  });

  socket.on('submit_guess', ({ guess }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'guessing') return;
    if (room.speakerOrder[room.speakerIdx] === socket.playerId) return;
    if (room.guesses.has(socket.playerId)) return;
    const player = room.players.get(socket.playerId);
    if (!player) return;
    const correct = fuzzyMatch(guess, room.selectedCeleb);
    const firstCorrect = correct && ![...room.guesses.values()].some(g => g.correct);
    const points = correct ? (firstCorrect ? 100 : 60) : 0;
    if (points) player.score += points;
    room.guesses.set(socket.playerId, { guess, correct, points, time: Date.now() });
    io.to(room.code).emit('guess_in', { playerId: socket.playerId, name: player.name, correct, firstCorrect, points });
    if (room.guesses.size >= room.speakerOrder.length - 1) endGuessing(room);
  });

  // ── Mode 2 — Noise Mimic ───────────────────────────────────────────────
  socket.on('creator_audio', ({ audioBase64 }, ack) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'noise_record') {
      if (typeof ack === 'function') ack({ err: 'Wrong phase' }); return;
    }
    if (room.speakerOrder[room.speakerIdx] !== socket.playerId) {
      if (typeof ack === 'function') ack({ err: 'Not your turn' }); return;
    }
    room.creatorAudio = audioBase64;
    room.phase = 'noise_mimic';
    if (typeof ack === 'function') ack({ ok: true });
    broadcastRoom(room);
    const crId = socket.playerId;
    for (const p of room.players.values()) {
      if (p.id !== crId && p.connected) io.to(p.socketId).emit('creator_audio', { audioBase64 });
    }
    setPhaseTimer(room, MIMIC_SUBMIT_SECS * 1000, () => finalizeMimics(room));
  });

  socket.on('mimic_audio', ({ audioBase64 }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'noise_mimic') return;
    if (room.speakerOrder[room.speakerIdx] === socket.playerId) return;
    if (room.mimics.has(socket.playerId)) return;
    room.mimics.set(socket.playerId, { audio: audioBase64, score: 0, commentary: '' });
    io.to(room.code).emit('mimic_in', {
      playerId: socket.playerId, name: room.players.get(socket.playerId)?.name ?? '?', audioBase64,
    });
    if (room.mimics.size >= room.speakerOrder.length - 1) finalizeMimics(room);
  });

  // ── Mode 3 — Voice Disguise / Imposter ────────────────────────────────
  socket.on('imposter_audio', ({ audioBase64 }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'imposter_record') return;
    if (room.imposterId !== socket.playerId) return;
    room.imposterAudio = audioBase64;
    room.phase = 'imposter_vote';
    broadcastRoom(room); // snapshot includes imposterAudio for everyone
    setPhaseTimer(room, IMPOSTER_VOTE_SECS * 1000, () => finalizeImposterVote(room));
  });

  socket.on('cast_imposter_vote', ({ targetId }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'imposter_vote') return;
    if (room.votes.has(socket.playerId)) return;
    if (!room.players.has(targetId)) return;
    room.votes.set(socket.playerId, targetId);
    broadcastRoom(room);
    if (room.votes.size >= room.players.size) finalizeImposterVote(room);
  });

  // ── Mode 5 — Word Imposter ────────────────────────────────────
  socket.on('wi_set_impostors', ({ count }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'lobby' || room.hostId !== socket.playerId) return;
    const n = parseInt(count, 10);
    if (n >= 1 && n <= 3) { room.wiImpostorCount = n; broadcastRoom(room); }
  });

  socket.on('wi_set_undercover', ({ enabled }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'lobby' || room.hostId !== socket.playerId) return;
    room.wiUndercoverMode = !!enabled; broadcastRoom(room);
  });

  socket.on('wi_submit_clue', ({ clue }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'wi_clue') return;
    if (room.wiClueOrder[room.wiCurrentClueIdx] !== socket.playerId) return;
    if (room.wiClues.has(socket.playerId)) return;
    const safeClue = String(clue || '').trim().slice(0, 50);
    if (!safeClue) return;
    room.wiClues.set(socket.playerId, safeClue);
    clearPhaseTimer(room);
    room.wiCurrentClueIdx++;
    advanceWiClue(room);
  });

  socket.on('wi_vote', ({ targetPid }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'wi_vote') return;
    if (room.wiVotes.has(socket.playerId)) return;
    if (targetPid === socket.playerId) return;
    if (room.wiEliminated.some(e => e.pid === targetPid)) return;
    if (!room.players.has(targetPid)) return;
    room.wiVotes.set(socket.playerId, targetPid);
    broadcastRoom(room);
    const alivePids = [...room.players.keys()].filter(pid => !room.wiEliminated.some(e => e.pid === pid));
    if (room.wiVotes.size >= alivePids.length) finalizeWiVote(room);
  });

  socket.on('wi_imposter_guess', ({ guess }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'wi_guess') return;
    if (room.wiAssignments.get(socket.playerId) !== 'imposter') return;
    const correct = fuzzyMatch(guess, room.wiCivilianWord);
    if (correct) { const p = room.players.get(socket.playerId); if (p) p.score += 75; }
    finalizeWiGame(room, 'imposter', correct);
  });

  // ── Mode 4 — Broken Telephone ──────────────────────────────────────────
  socket.on('telephone_audio', ({ audioBase64 }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'telephone_chain') return;
    if (room.telephoneChain[room.telephoneCurrentIdx] !== socket.playerId) return;
    const player = room.players.get(socket.playerId);
    room.telephoneRecordings.push({ pid: socket.playerId, name: player?.name ?? '?', audio: audioBase64 });
    const nextIdx = room.telephoneCurrentIdx + 1;
    if (nextIdx < room.telephoneChain.length) {
      room.telephoneCurrentIdx = nextIdx;
      broadcastRoom(room);
      const next = room.players.get(room.telephoneChain[nextIdx]);
      if (next) io.to(next.socketId).emit('telephone_listen', {
        audioBase64, chainIdx: nextIdx, chainLength: room.telephoneChain.length,
      });
    } else {
      finalizeTelephone(room);
    }
  });

  socket.on('telephone_vote_accurate', ({ targetPid }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'telephone_vote') return;
    if (room.telephoneVotesAccurate.has(socket.playerId)) return;
    room.telephoneVotesAccurate.set(socket.playerId, targetPid);
    broadcastRoom(room);
    if (room.telephoneVotesAccurate.size >= room.players.size &&
        room.telephoneVotesBlunder.size  >= room.players.size) finalizeTelephoneVote(room);
  });

  socket.on('telephone_vote_blunder', ({ targetPid }) => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'telephone_vote') return;
    if (room.telephoneVotesBlunder.has(socket.playerId)) return;
    room.telephoneVotesBlunder.set(socket.playerId, targetPid);
    broadcastRoom(room);
    if (room.telephoneVotesAccurate.size >= room.players.size &&
        room.telephoneVotesBlunder.size  >= room.players.size) finalizeTelephoneVote(room);
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
    for (const p of room.players.values()) { p.score = 0; p.ready = false; }
    room.currentRound = 0; room.usedCelebs = [];
    room.speakerOrder = shuffle([...room.players.keys()]);
    startRound(room);
  });

  socket.on('back_to_lobby', () => {
    const room = roomOf(socket);
    if (!room || room.phase !== 'final') return;
    if (room.hostId !== socket.playerId) return;
    for (const p of room.players.values()) { p.score = 0; p.ready = false; }
    room.currentRound = 0; room.usedCelebs = [];
    room.phase = 'lobby';
    clearPhaseTimer(room);
    broadcastRoom(room);
  });

  // ── Kick / Leave ───────────────────────────────────────────────────────
  socket.on('kick_player', ({ targetId }) => {
    const room = roomOf(socket);
    if (!room || room.hostId !== socket.playerId) return;
    if (targetId === room.hostId) return;
    const target = room.players.get(targetId);
    if (!target) return;
    if (target.disconnectTimer) { clearTimeout(target.disconnectTimer); target.disconnectTimer = null; }
    room.players.delete(targetId);
    if (target.connected) io.to(target.socketId).emit('kicked', { msg: 'You were removed by the host.' });
    if (room.players.size === 0) { rooms.delete(room.code); return; }
    broadcastRoom(room);
  });

  socket.on('leave_room', () => {
    const room = roomOf(socket);
    if (!room) return;
    const player = room.players.get(socket.playerId);
    if (!player) return;
    if (player.disconnectTimer) { clearTimeout(player.disconnectTimer); player.disconnectTimer = null; }
    room.players.delete(socket.playerId);
    socket.leave(room.code);
    socket.roomCode = null;
    if (room.players.size === 0) { rooms.delete(room.code); return; }
    if (room.hostId === socket.playerId) {
      const next = room.players.values().next().value;
      if (next) { next.isHost = true; room.hostId = next.id; }
    }
    broadcastRoom(room);
  });

  socket.on('force_lobby', () => {
    const room = roomOf(socket);
    if (!room || room.hostId !== socket.playerId) return;
    clearPhaseTimer(room);
    for (const p of room.players.values()) { p.score = 0; p.ready = false; }
    room.currentRound = 0; room.usedCelebs = [];
    room.phase = 'lobby';
    room.speakerAudio = null; room.creatorAudio = null;
    room.selectedCeleb = null; room.roundResult = null;
    room.votes.clear();
    room.imposterId = null; room.imposterAudio = null; room.imposterPrompt = null; room.imposterEffect = null;
    room.telephoneChain = []; room.telephoneCurrentIdx = 0;
    room.telephoneRecordings = []; room.telephonePrompt = null;
    room.telephoneVotesAccurate.clear(); room.telephoneVotesBlunder.clear();
    room.wiAssignments.clear(); room.wiWords.clear(); room.wiClues.clear(); room.wiVotes.clear();
    room.wiEliminated = []; room.wiCycleCount = 0; room.wiCurrentClueIdx = 0; room.wiClueOrder = [];
    room.wiCivilianWord = null; room.wiImposterWord = null;
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
