'use strict';

// ═══════════════════════════════════════════════════════════════
// SESSION PERSISTENCE  (survives app-switch on mobile)
// ═══════════════════════════════════════════════════════════════
const SESSION = {
  get id()   { return localStorage.getItem('ec_pid'); },
  get name() { return localStorage.getItem('ec_pname'); },
  get room() { return localStorage.getItem('ec_room'); },
  save(pid, name, room) {
    localStorage.setItem('ec_pid',   pid);
    localStorage.setItem('ec_pname', name);
    localStorage.setItem('ec_room',  room);
  },
  clear() {
    ['ec_pid','ec_pname','ec_room'].forEach(k => localStorage.removeItem(k));
  },
};

// ═══════════════════════════════════════════════════════════════
// GAME STATE
// ═══════════════════════════════════════════════════════════════
const G = {
  socket:       null,
  audio:        null,
  myId:         null,
  myName:       '',
  room:         null,          // server snapshot
  // role hints sent privately by server
  isSpeaker:    false,
  isCreator:    false,
  // audio buffers
  speakerBuf:   null,          // reversed audio from speaker
  mimicBuf:     null,          // my reversed mimic
  creatorBuf:   null,          // noise creator audio
  myMimicBuf:   null,          // my noise mimic
  // phase timers
  timerHandle:  null,
  timerEnd:     null,
  timerEl:      null,
  timerBarEl:   null,
  // ui state
  guessSubmitted: false,
  mimicSubmitted: false,
  celebOptions:   [],
};

// ═══════════════════════════════════════════════════════════════
// AUDIO MANAGER
// ═══════════════════════════════════════════════════════════════
class AudioManager {
  constructor() { this.ctx = null; this.stream = null; this.rec = null; this.chunks = []; this.recording = false; this._st = null; }

  async init() {
    this.ctx    = new (window.AudioContext || window.webkitAudioContext)();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation:true, noiseSuppression:true } });
  }

  start(onDone, maxMs = 8000) {
    if (this.recording) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.chunks = [];
    const mime = ['audio/webm;codecs=opus','audio/webm','audio/ogg','']
      .find(t => !t || MediaRecorder.isTypeSupported(t));
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : {});
    this.rec.ondataavailable = e => { if (e.data.size > 0) this.chunks.push(e.data); };
    this.rec.onstop = async () => {
      clearTimeout(this._st);
      const blob = new Blob(this.chunks, { type: this.rec.mimeType || 'audio/webm' });
      try {
        const buf = await this.ctx.decodeAudioData(await blob.arrayBuffer());
        onDone(buf);
      } catch(e) { console.error('decodeAudioData:', e); onDone(null); }
    };
    this.rec.start(100);
    this.recording = true;
    this._st = setTimeout(() => this.stop(), maxMs);
  }

  stop() {
    if (!this.recording) return;
    clearTimeout(this._st);
    if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    this.recording = false;
  }

  clone(buf) {
    const c = this.ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let i = 0; i < buf.numberOfChannels; i++) c.getChannelData(i).set(buf.getChannelData(i));
    return c;
  }

  reverse(buf) {
    for (let i = 0; i < buf.numberOfChannels; i++)
      Array.prototype.reverse.call(buf.getChannelData(i));
    return buf;
  }

  async play(buf, onended) {
    try {
      if (this.ctx.state !== 'running') await this.ctx.resume();
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.ctx.destination);
      if (onended) src.onended = onended;
      src.start();
      return src;
    } catch(e) {
      console.error('play() failed:', e);
      toast('Could not play audio — tap the screen first and try again', 'error');
      return null;
    }
  }

  toBase64(buf) {
    const wav = this._wav(buf);
    const u8  = new Uint8Array(wav);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000)
      s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  }

  async fromBase64(b64) {
    const bin  = atob(b64);
    const u8   = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return this.ctx.decodeAudioData(u8.buffer.slice(0));
  }

  _wav(buf) {
    const sr   = buf.sampleRate;
    let s      = buf.getChannelData(0);
    if (buf.numberOfChannels > 1) {
      const r = buf.getChannelData(1);
      const m = new Float32Array(s.length);
      for (let i = 0; i < s.length; i++) m[i] = (s[i] + r[i]) / 2;
      s = m;
    }
    const ab = new ArrayBuffer(44 + s.length * 2);
    const v  = new DataView(ab);
    const ws = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o+i, t.charCodeAt(i)); };
    ws(0,'RIFF'); v.setUint32(4,36+s.length*2,true); ws(8,'WAVE'); ws(12,'fmt ');
    v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
    v.setUint32(24,sr,true); v.setUint32(28,sr*2,true); v.setUint16(32,2,true); v.setUint16(34,16,true);
    ws(36,'data'); v.setUint32(40,s.length*2,true);
    let o = 44;
    for (let i = 0; i < s.length; i++) {
      const x = Math.max(-1,Math.min(1,s[i]));
      v.setInt16(o,x<0?x*0x8000:x*0x7FFF,true); o+=2;
    }
    return ab;
  }
}

// ═══════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════
const $app   = () => document.getElementById('app');
const $id    = id => document.getElementById(id);
const esc    = s  => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function render(html) { $app().innerHTML = html; }

function toast(msg, type = 'info') {
  const c  = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  c.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3500);
}

function playerColor(idx) {
  const cols = ['#00d4ff','#ff006e','#39ff14','#ff6b00','#bf00ff','#ffd700','#ff3333','#00ffaa'];
  return cols[idx % cols.length];
}

function avatarHTML(name, idx) {
  const bg = playerColor(idx);
  return `<div class="player-avatar" style="background:${bg}22;color:${bg};border:1.5px solid ${bg}40">${esc(name[0]?.toUpperCase() || '?')}</div>`;
}

function scoreboardHTML() {
  if (!G.room?.players?.length) return '';
  const pl = [...G.room.players].sort((a,b) => b.score - a.score);
  return `<div class="scoreboard">${pl.map(p => `
    <div class="score-chip ${p.id === G.myId ? 'me' : ''}">
      <span class="sc-name">${esc(p.name)}</span>
      <span class="sc-val">${p.score}</span>
    </div>`).join('')}</div>`;
}

function roundBadge() {
  if (!G.room) return '';
  return `<div class="round-badge">Round ${G.room.currentRound} of ${G.room.roundCount}</div>`;
}

// ── Countdown timer bar ──────────────────────────────────────────────────────
function startClientTimer(totalSec, elBar, elLabel) {
  clearInterval(G.timerHandle);
  G.timerEnd = Date.now() + totalSec * 1000;
  G.timerEl  = elLabel;
  G.timerBarEl = elBar;

  function tick() {
    const left = Math.max(0, G.timerEnd - Date.now());
    const pct  = (left / (totalSec * 1000)) * 100;
    if (elBar)   { elBar.style.width = pct + '%'; if (left < totalSec * 333) elBar.classList.add('warning'); }
    if (elLabel) { elLabel.textContent = Math.ceil(left/1000) + 's'; if (left < 10000) elLabel.classList.add('warning'); }
    if (left <= 0) clearInterval(G.timerHandle);
  }

  G.timerHandle = setInterval(tick, 500);
  tick();
}

function stopClientTimer() { clearInterval(G.timerHandle); }

// ── Audio player widget ──────────────────────────────────────────────────────
function audioPlayerWidget(audioBuf, label) {
  const wrap = document.createElement('div');
  wrap.className = 'audio-player';
  const canvas = document.createElement('canvas');
  canvas.className = 'waveform';
  canvas.width  = 180;
  canvas.height = 36;
  const playBtn = document.createElement('button');
  playBtn.className = 'play-btn';
  playBtn.textContent = '▶';
  const lbl = document.createElement('span');
  lbl.className = 'audio-label';
  lbl.textContent = label || '';
  wrap.appendChild(playBtn);
  wrap.appendChild(canvas);
  wrap.appendChild(lbl);

  // Draw waveform
  const ctx = canvas.getContext('2d');
  const data = audioBuf.getChannelData(0);
  const W = canvas.width, H = canvas.height;
  const step = Math.ceil(data.length / W);
  ctx.fillStyle = 'rgba(0,212,255,.05)';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#00d4ff';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < W; x++) {
    let peak = 0;
    for (let j = 0; j < step; j++) {
      const v = Math.abs(data[Math.min(x*step+j, data.length-1)] || 0);
      if (v > peak) peak = v;
    }
    const h = peak * (H/2);
    if (x === 0) ctx.moveTo(x, H/2 - h);
    else          ctx.lineTo(x, H/2 - h);
  }
  for (let x = W-1; x >= 0; x--) {
    let peak = 0;
    for (let j = 0; j < step; j++) {
      const v = Math.abs(data[Math.min(x*step+j, data.length-1)] || 0);
      if (v > peak) peak = v;
    }
    const h = peak * (H/2);
    ctx.lineTo(x, H/2 + h);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,212,255,.2)';
  ctx.fill();
  ctx.stroke();

  let src = null;
  playBtn.onclick = async () => {
    if (src) { try { src.stop(); } catch(e){} src = null; playBtn.textContent = '▶'; return; }
    playBtn.textContent = '⏹';
    playBtn.disabled = true;
    src = await G.audio.play(audioBuf, () => { src = null; playBtn.textContent = '▶'; playBtn.disabled = false; });
    playBtn.disabled = false;
    if (!src) playBtn.textContent = '▶'; // play failed
  };

  return wrap;
}

// ── Record button setup ──────────────────────────────────────────────────────
let _recInterval = null;
let _recSecs     = 0;

function setupRecBtn(btnId, timerId, maxSec, onDone) {
  const btn = $id(btnId);
  const tmr = $id(timerId);
  if (!btn) return;

  const resetBtn = () => {
    btn.dataset.state = 'idle';
    const lbl = btn.querySelector('.rec-label');
    if (lbl) lbl.textContent = 'Hold to Record';
  };

  const startR = e => {
    e.preventDefault();
    if (btn.dataset.state !== 'idle') return;
    btn.dataset.state = 'recording';
    const lbl = btn.querySelector('.rec-label');
    if (lbl) lbl.textContent = 'Recording… Release to stop';
    _recSecs = maxSec;
    if (tmr) { tmr.textContent = `${_recSecs}s`; tmr.classList.remove('hidden'); }
    _recInterval = setInterval(() => {
      _recSecs--;
      if (tmr) tmr.textContent = `${_recSecs}s`;
      if (_recSecs <= 0) { clearInterval(_recInterval); G.audio.stop(); }
    }, 1000);
    G.audio.start(buf => {
      clearInterval(_recInterval);
      if (tmr) tmr.classList.add('hidden');
      if (!buf) { toast('Recording failed — try again', 'error'); resetBtn(); onDone(null); return; }
      btn.dataset.state = 'done';
      const lbl2 = btn.querySelector('.rec-label');
      if (lbl2) lbl2.textContent = 'Recorded ✓';
      onDone(buf);
    }, maxSec * 1000);
  };

  const stopR = e => {
    e.preventDefault();
    if (btn.dataset.state !== 'recording') return;
    clearInterval(_recInterval);
    G.audio.stop();
    const lbl = btn.querySelector('.rec-label');
    if (lbl) lbl.textContent = 'Processing…';
  };

  btn.addEventListener('mousedown',  startR);
  btn.addEventListener('touchstart', startR, { passive: false });
  btn.addEventListener('mouseup',    stopR);
  btn.addEventListener('touchend',   stopR,  { passive: false });
  btn.addEventListener('mouseleave', e => { if (btn.dataset.state === 'recording') stopR(e); });
}

// ── Confetti ─────────────────────────────────────────────────────────────────
function launchConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  if (!canvas) return;
  const ctx  = canvas.getContext('2d');
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  const colors  = ['#ffd700','#ff006e','#00d4ff','#39ff14','#bf00ff','#ff6b00'];
  const parts   = Array.from({ length: 180 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * 100,
    vx: (Math.random()-0.5) * 4,
    vy: Math.random() * 3 + 1.5,
    w: Math.random() * 10 + 5,
    h: Math.random() * 6 + 3,
    color: colors[Math.floor(Math.random()*colors.length)],
    rot: Math.random()*360,
    rv:  (Math.random()-0.5)*8,
  }));
  let raf;
  function draw() {
    ctx.clearRect(0,0,canvas.width,canvas.height);
    let alive = false;
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.08; p.rot += p.rv;
      if (p.y < canvas.height + 20) alive = true;
      ctx.save();
      ctx.translate(p.x,p.y); ctx.rotate(p.rot*Math.PI/180);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w/2,-p.h/2,p.w,p.h);
      ctx.restore();
    }
    if (alive) { raf = requestAnimationFrame(draw); }
    else { ctx.clearRect(0,0,canvas.width,canvas.height); }
  }
  draw();
  setTimeout(() => { cancelAnimationFrame(raf); ctx.clearRect(0,0,canvas.width,canvas.height); }, 7000);
}

// ═══════════════════════════════════════════════════════════════
// SCREENS
// ═══════════════════════════════════════════════════════════════

function showLanding() {
  render(`
    <div class="screen">
      <div class="logo">
        <div class="logo-icon">🎤</div>
        <h1><span class="gradient-text">EchoClash</span></h1>
        <p class="logo-sub">Party Voice Game</p>
        <p class="tagline">2–8 players · Voice reversal · Sound mimicry</p>
      </div>

      <div class="card card-glow-blue">
        <h3>Create a Room</h3>
        <div class="field">
          <label>Your Name</label>
          <input id="c-name" type="text" placeholder="Enter your name" maxlength="20" autocomplete="off" />
        </div>
        <button id="btn-create" class="btn-primary btn-full">Create Room 🚀</button>
      </div>

      <div class="card">
        <h3>Join a Room</h3>
        <div class="field">
          <label>Your Name</label>
          <input id="j-name" type="text" placeholder="Enter your name" maxlength="20" autocomplete="off" />
        </div>
        <div class="field">
          <label>Room Code</label>
          <input id="j-code" type="text" placeholder="e.g. ABCD" maxlength="6" autocomplete="off" style="text-transform:uppercase;letter-spacing:4px;font-weight:800;" />
        </div>
        <button id="btn-join" class="btn-danger btn-full">Join Room 🎉</button>
      </div>
    </div>
  `);

  $id('c-name').value = SESSION.name || '';
  $id('j-name').value = SESSION.name || '';

  $id('btn-create').onclick = () => doCreate($id('c-name').value.trim());
  $id('btn-join').onclick   = () => doJoin($id('j-name').value.trim(), $id('j-code').value.trim().toUpperCase());

  // Clear stale session if they manually navigated back to landing
  if (SESSION.id) {
    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn-ghost btn-sm';
    clearBtn.style.cssText = 'margin-top:4px;font-size:.78rem;color:var(--text3);';
    clearBtn.textContent = '✕ Clear saved session & start fresh';
    clearBtn.onclick = () => { SESSION.clear(); G.socket?.disconnect(); G.socket = null; G.audio = null; showLanding(); };
    $app().appendChild(clearBtn);
  }
  $id('j-code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });
  $id('c-name').addEventListener('keydown', e => { if (e.key === 'Enter') doCreate($id('c-name').value.trim()); });
  $id('j-code').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin($id('j-name').value.trim(), $id('j-code').value.trim().toUpperCase()); });
}

function showLobby() {
  const room = G.room;
  const amHost = room.hostId === G.myId;
  const me = room.players.find(p => p.id === G.myId);
  const allReady = room.players.every(p => p.ready || p.id === room.hostId);
  const canStart = amHost && room.players.length >= 2;

  render(`
    <div class="screen">
      <div class="logo" style="padding-bottom:0">
        <h1><span class="gradient-text">EchoClash</span></h1>
      </div>

      <div class="card text-center">
        <small>Room Code — share with friends!</small>
        <div class="room-code-big">${esc(room.code)}</div>
        <button id="btn-copy" class="btn-ghost btn-sm btn-full">📋 Copy Link</button>
      </div>

      <div class="card">
        <h3>Players (${room.players.length}/8)</h3>
        <div class="player-list">
          ${room.players.map((p, i) => `
            <div class="player-row ${p.id === G.myId ? 'me' : ''} ${!p.connected ? 'disconnected' : ''}">
              ${avatarHTML(p.name, i)}
              <span class="player-name">${esc(p.name)} ${p.isHost ? '<span class="player-host-badge">Host</span>' : ''}</span>
              <span class="player-ready ${p.ready || p.isHost ? 'is-ready' : ''}">${p.isHost ? '👑' : p.ready ? '✅' : '⏳'}</span>
              ${amHost && !p.isHost ? `<button class="btn-kick" data-id="${esc(p.id)}" data-name="${esc(p.name)}" title="Kick player">🚫</button>` : ''}
            </div>`).join('')}
        </div>
        ${!amHost ? `
          <button id="btn-ready" class="btn-${me?.ready ? 'ghost' : 'green'} btn-full">${me?.ready ? '✅ Ready (click to unready)' : 'Mark as Ready ✅'}</button>
          <button id="btn-leave" class="btn-ghost btn-full" style="margin-top:6px;color:var(--red)">Leave Room 🚪</button>
        ` : ''}
      </div>

      ${amHost ? `
      <div class="card card-glow-blue">
        <h3>Game Settings</h3>
        <div class="field"><label>Game Mode</label>
          <div class="mode-buttons">
            <button class="btn-mode ${room.mode==='reverse'?'active':''}" id="mode-rev">
              <span class="mode-icon">🔀</span>Reverse Voice Challenge
            </button>
            <button class="btn-mode ${room.mode==='noise'?'active':''}" id="mode-noise">
              <span class="mode-icon">🔊</span>AI Noise Mimic
            </button>
          </div>
        </div>
        <div class="field">
          <label>Rounds (2–20)</label>
          <input id="inp-rounds" type="number" min="2" max="20" value="${room.roundCount}" />
        </div>
        <button id="btn-start" class="btn-primary btn-full btn-large" ${canStart?'':'disabled'}>
          Start Game ▶
        </button>
        ${room.players.length < 2 ? '<small style="text-align:center;color:var(--text3)">Waiting for at least 1 more player…</small>' : ''}
        <button id="btn-host-leave" class="btn-ghost btn-full" style="margin-top:6px;color:var(--red);font-size:.85rem">Leave Room 🚪</button>
      </div>` : `
      <div class="card text-center">
        <p>Waiting for the host to start…</p>
        <div class="spinner" style="margin:12px auto"></div>
      </div>`}
    </div>
  `);

  $id('btn-copy').onclick = () => {
    const url = `${location.origin}?room=${room.code}`;
    navigator.clipboard.writeText(url).then(() => toast('Invite link copied!','success')).catch(() => toast(`Room: ${room.code}`,'info'));
  };

  if (!amHost) {
    $id('btn-ready').onclick = () => {
      const ready = !(me?.ready);
      G.socket.emit('set_ready', { ready });
    };
    $id('btn-leave').onclick = () => {
      if (confirm('Leave the room?')) {
        G.socket.emit('leave_room');
        SESSION.clear();
        G.room = null;
        showLanding();
      }
    };
  } else {
    $id('mode-rev').onclick   = () => G.socket.emit('host_set_mode', { mode:'reverse' });
    $id('mode-noise').onclick = () => G.socket.emit('host_set_mode', { mode:'noise' });
    $id('inp-rounds').onchange = () => {
      const v = parseInt($id('inp-rounds').value, 10);
      if (v >= 2 && v <= 20) G.socket.emit('host_set_rounds', { count: v });
    };
    $id('btn-start').onclick = () => G.socket.emit('host_start');
    $id('btn-host-leave').onclick = () => {
      if (confirm('Leave the room? Another player will become host.')) {
        G.socket.emit('leave_room');
        SESSION.clear();
        G.room = null;
        showLanding();
      }
    };
    document.querySelectorAll('.btn-kick').forEach(b => {
      b.onclick = () => {
        if (confirm(`Kick ${b.dataset.name} from the room?`)) {
          G.socket.emit('kick_player', { targetId: b.dataset.id });
        }
      };
    });
  }

  // Pre-fill room code from URL
  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) { const el = $id('j-code'); if (el) el.value = urlRoom; }
}

// ── SPEAKER: Category select ──────────────────────────────────────────────
function showSpeakerCatSelect() {
  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="role-banner speaker">🎙️ You are the Speaker</div>
      <h2 class="text-center">Choose a category</h2>
      <p class="text-center">Your voice will be reversed — opponents must guess!</p>
      <div class="grid-cat">
        <button class="btn-cat" data-cat="footballers"><span class="cat-icon">⚽</span>Footballers</button>
        <button class="btn-cat" data-cat="singers"><span class="cat-icon">🎵</span>Singers</button>
        <button class="btn-cat" data-cat="actors"><span class="cat-icon">🎬</span>Actors</button>
        <button class="btn-cat" data-cat="internet"><span class="cat-icon">📱</span>Internet Icons</button>
        <button class="btn-cat" style="grid-column:1/-1" data-cat="mixed"><span class="cat-icon">🌀</span>Mixed — All Categories</button>
      </div>
      ${scoreboardHTML()}
    </div>
  `);
  document.querySelectorAll('.btn-cat').forEach(b => {
    b.onclick = () => G.socket.emit('select_category', { category: b.dataset.cat });
  });
}

// ── SPEAKER: Celebrity select ─────────────────────────────────────────────
function showSpeakerCelebSelect(options) {
  G.celebOptions = options;
  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="role-banner speaker">🎙️ Speaker — Pick a Celebrity</div>
      <h2 class="text-center">Choose one secretly</h2>
      <p class="text-center">You'll say their name into your mic — reversed!</p>
      <div class="grid-2">
        ${options.map(c => `<button class="btn-celeb" data-c="${esc(c)}">${esc(c)}</button>`).join('')}
      </div>
      ${scoreboardHTML()}
    </div>
  `);
  document.querySelectorAll('.btn-celeb').forEach(b => {
    b.onclick = () => G.socket.emit('select_celeb', { celeb: b.dataset.c });
  });
}

// ── SPEAKER: Record ───────────────────────────────────────────────────────
function showSpeakerRecord(celeb) {
  G.speakerBuf = null;
  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="role-banner speaker">🎙️ Speaker — Record</div>
      <h2 class="text-center">Say this name clearly:</h2>
      <div class="celeb-big">${esc(celeb)}</div>
      <div class="card">
        <p class="text-center">Hold the button and say the name. Don't give it away!</p>
        <div class="record-area">
          <button id="btn-rec" class="btn-record" data-state="idle" style="display:flex">
            <span class="rec-icon">🎤</span>
            <span class="rec-label">Hold to Record</span>
          </button>
          <div id="rec-tmr" class="rec-timer hidden"></div>
        </div>
        <div id="prev-area" class="preview-area hidden">
          <p>🔀 Reversed preview (what opponents hear):</p>
          <div id="prev-player"></div>
          <div class="flex-row mt-8">
            <button id="btn-send" class="btn-primary">Send Reversed Audio ✈️</button>
            <button id="btn-rerec" class="btn-ghost">🔄 Re-record</button>
          </div>
        </div>
      </div>
      ${scoreboardHTML()}
    </div>
  `);

  setupRecBtn('btn-rec', 'rec-tmr', 8, buf => {
    if (!buf) return;
    const rev = G.audio.reverse(G.audio.clone(buf));
    G.speakerBuf = rev;
    $id('prev-area').classList.remove('hidden');
    $id('prev-player').appendChild(audioPlayerWidget(rev, 'Reversed'));
    $id('btn-send').onclick = sendSpeakerAudio;
    $id('btn-rerec').onclick = () => {
      G.speakerBuf = null;
      $id('prev-area').classList.add('hidden');
      $id('prev-player').innerHTML = '';
      const b = $id('btn-rec');
      if (b) { b.dataset.state='idle'; b.querySelector('.rec-label').textContent='Hold to Record'; }
    };
  });
}

async function sendSpeakerAudio() {
  if (!G.speakerBuf) return;
  const btn = $id('btn-send');
  if (btn) { btn.disabled=true; btn.textContent='Sending…'; }
  try {
    const b64 = G.audio.toBase64(G.speakerBuf);
    G.socket.emit('speaker_audio', { audioBase64: b64 });
  } catch(e) {
    toast('Failed to send audio','error');
    if (btn) { btn.disabled=false; btn.textContent='Send Reversed Audio ✈️'; }
  }
}

// ── SPEAKER: Waiting for guesses ──────────────────────────────────────────
function showSpeakerWaiting() {
  const guessers = G.room.players.filter(p => p.id !== G.room.speakerOrder?.[G.room.speakerIdx]);
  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="role-banner speaker">🎙️ Speaker</div>
      <div class="wait-center">
        <div class="wait-icon">😈</div>
        <h2>Opponents are guessing…</h2>
        <p>Did you stump them?</p>
      </div>
      <div class="card">
        <h3>Live Guesses</h3>
        <div id="live-feed" class="live-feed">
          <div class="feed-item info">Waiting for guesses…</div>
        </div>
      </div>
      <div class="card">
        <div class="timer-bar-wrap"><div id="t-bar" class="timer-bar" style="width:100%"></div></div>
        <div class="timer-label" id="t-lbl">45s</div>
      </div>
      ${scoreboardHTML()}
    </div>
  `);
  if (G.room.phaseEndEpoch) {
    const left = Math.max(0, G.room.phaseEndEpoch - Date.now()) / 1000;
    startClientTimer(left, $id('t-bar'), $id('t-lbl'));
  } else { startClientTimer(45, $id('t-bar'), $id('t-lbl')); }
}

// ── GUESSER: Guessing turn ────────────────────────────────────────────────
function showGuesserTurn(audioBuf) {
  G.guessSubmitted = false;
  G.mimicBuf       = null;
  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="role-banner guesser">👂 You are a Guesser</div>
      <div class="card card-glow-blue">
        <h3>Step 1 — Listen to reversed audio</h3>
        <div id="rev-player"></div>
        <p style="font-size:.82rem;color:var(--text3)">Play as many times as you need!</p>
      </div>
      <div class="card">
        <h3>Step 2 — Mimic & reverse it yourself</h3>
        <p>Record yourself saying those backwards sounds. Your mimic will be reversed again to help you guess!</p>
        <div class="record-area">
          <button id="btn-mimic" class="btn-record" data-state="idle" style="display:flex">
            <span class="rec-icon">🎤</span><span class="rec-label">Hold to Mimic</span>
          </button>
          <div id="mimic-tmr" class="rec-timer hidden"></div>
        </div>
        <div id="mimic-prev" class="preview-area hidden">
          <p>🔀 Your reversed mimic (should sound like the name!):</p>
          <div id="mimic-player"></div>
          <button id="btn-remimic" class="btn-ghost btn-sm">🔄 Re-mimic</button>
        </div>
      </div>
      <div class="card card-glow-pink">
        <h3>Step 3 — Type your guess</h3>
        <input id="inp-guess" type="text" class="guess-input" placeholder="Celebrity name…" autocomplete="off" />
        <button id="btn-submit-guess" class="btn-danger btn-full" disabled>Submit Guess 🎯</button>
        <div class="timer-bar-wrap"><div id="t-bar" class="timer-bar" style="width:100%"></div></div>
        <div class="timer-label" id="t-lbl">45s</div>
      </div>
      <div id="live-feed" class="live-feed card" style="gap:6px"></div>
      ${scoreboardHTML()}
    </div>
  `);

  // Reversed audio player
  $id('rev-player').appendChild(audioPlayerWidget(audioBuf, 'Reversed'));

  // Mimic recording
  setupRecBtn('btn-mimic','mimic-tmr', 8, buf => {
    if (!buf) return;
    const rev = G.audio.reverse(G.audio.clone(buf));
    G.mimicBuf = rev;
    const mp = $id('mimic-player');
    if (mp) { mp.innerHTML=''; mp.appendChild(audioPlayerWidget(rev,'Your Mimic Reversed')); }
    const pa = $id('mimic-prev');
    if (pa) pa.classList.remove('hidden');

    // Send to server for reveal
    try {
      G.socket.emit('mimic_audio', { audioBase64: G.audio.toBase64(rev) });
    } catch(e) { console.error(e); }

    $id('btn-remimic').onclick = () => {
      G.mimicBuf = null;
      $id('mimic-prev').classList.add('hidden');
      $id('mimic-player').innerHTML = '';
      const b = $id('btn-mimic');
      if (b) { b.dataset.state='idle'; b.querySelector('.rec-label').textContent='Hold to Mimic'; }
    };
  });

  // Guess input
  const inp = $id('inp-guess');
  const sub = $id('btn-submit-guess');
  inp.oninput = () => { sub.disabled = !inp.value.trim() || G.guessSubmitted; };
  inp.onkeydown = e => { if (e.key==='Enter' && !sub.disabled) submitGuess(); };
  sub.onclick = submitGuess;

  // Timer
  const left = G.room.phaseEndEpoch ? Math.max(0,(G.room.phaseEndEpoch-Date.now())/1000) : 45;
  startClientTimer(left, $id('t-bar'), $id('t-lbl'));
}

function submitGuess() {
  if (G.guessSubmitted) return;
  const val = $id('inp-guess')?.value.trim();
  if (!val) return;
  G.guessSubmitted = true;
  stopClientTimer();
  const sub = $id('btn-submit-guess');
  if (sub) { sub.disabled=true; sub.textContent='Submitted! ⏳'; }
  G.socket.emit('submit_guess', { guess: val });
}

function addFeedItem(html, cls) {
  const feed = $id('live-feed');
  if (!feed) return;
  const d = document.createElement('div');
  d.className = `feed-item ${cls}`;
  d.innerHTML = html;
  feed.appendChild(d);
  feed.scrollTop = feed.scrollHeight;
}

// ── NOISE CREATOR: Record ─────────────────────────────────────────────────
function showNoiseCreatorRecord() {
  G.creatorBuf = null;
  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="role-banner creator">🔊 You are the Noise Creator</div>
      <h2 class="text-center">Find something to record!</h2>
      <div class="card card-glow-green">
        <p>Record any sound from your environment:</p>
        <ul style="color:var(--text2);font-size:.9rem;line-height:2;padding-left:20px">
          <li>Tap a spoon on glass</li>
          <li>Crunch a chip bag</li>
          <li>Clicking a pen rapidly</li>
          <li>Opening a soda can</li>
          <li>Weird mouth/tongue sounds</li>
        </ul>
        <div class="record-area">
          <button id="btn-noise-rec" class="btn-record" data-state="idle" style="display:flex">
            <span class="rec-icon">🎤</span><span class="rec-label">Hold to Record</span>
          </button>
          <div id="noise-tmr" class="rec-timer hidden"></div>
        </div>
        <div id="noise-prev" class="preview-area hidden">
          <div id="noise-player"></div>
          <div class="flex-row">
            <button id="btn-send-noise" class="btn-primary">Send to Players 📡</button>
            <button id="btn-renoise" class="btn-ghost">🔄 Re-record</button>
          </div>
        </div>
      </div>
      ${scoreboardHTML()}
    </div>
  `);

  setupRecBtn('btn-noise-rec','noise-tmr',10, buf => {
    if (!buf) return;
    G.creatorBuf = buf;
    $id('noise-prev').classList.remove('hidden');
    $id('noise-player').appendChild(audioPlayerWidget(buf,'Your Sound'));
    $id('btn-send-noise').onclick = sendCreatorAudio;
    $id('btn-renoise').onclick = () => {
      G.creatorBuf = null;
      $id('noise-prev').classList.add('hidden');
      $id('noise-player').innerHTML = '';
      const b = $id('btn-noise-rec');
      if (b) { b.dataset.state='idle'; b.querySelector('.rec-label').textContent='Hold to Record'; }
    };
  });
}

async function sendCreatorAudio() {
  if (!G.creatorBuf) { toast('No recording found — record first!', 'error'); return; }
  const btn = $id('btn-send-noise');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending… ⏳'; }
  try {
    const b64 = G.audio.toBase64(G.creatorBuf);
    G.socket.emit('creator_audio', { audioBase64: b64 }, (ack) => {
      if (ack?.ok) {
        toast('Sound sent to everyone! 📡', 'success');
      } else if (ack?.err) {
        toast('Server rejected audio: ' + ack.err, 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Send to Players 📡'; }
      }
    });
    // Fallback if server doesn't ack within 5s
    setTimeout(() => {
      if (btn && btn.disabled) { btn.disabled = false; btn.textContent = 'Sent ✓'; }
    }, 5000);
  } catch(e) {
    console.error('sendCreatorAudio:', e);
    toast('Failed to encode audio — try a shorter recording', 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Send to Players 📡'; }
  }
}

// ── NOISE MIMIC: Mimic turn ───────────────────────────────────────────────
function showNoiseMimicTurn(targetBuf) {
  G.mimicSubmitted = false;
  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="role-banner mimic">🎭 Mimic the Sound!</div>
      <div class="card card-glow-blue">
        <h3>Target Sound</h3>
        <div id="target-player"></div>
        <p style="font-size:.82rem;color:var(--text3)">Listen as many times as you need!</p>
      </div>
      <div class="card">
        <h3>Your Mimic</h3>
        <p>Record your best vocal replica of that sound.</p>
        <div class="record-area">
          <button id="btn-mm" class="btn-record" data-state="idle" style="display:flex">
            <span class="rec-icon">🎤</span><span class="rec-label">Hold to Record</span>
          </button>
          <div id="mm-tmr" class="rec-timer hidden"></div>
        </div>
        <div id="mm-prev" class="preview-area hidden">
          <div id="mm-player"></div>
          <div class="flex-row mt-8">
            <button id="btn-send-mm" class="btn-primary">Submit Mimic 🎯</button>
            <button id="btn-remm" class="btn-ghost">🔄 Re-record</button>
          </div>
        </div>
        <div id="mm-submitted" class="hidden text-center" style="color:var(--green);font-weight:700">✅ Mimic submitted! Waiting for others…</div>
      </div>
      <div class="card">
        <div class="timer-bar-wrap"><div id="t-bar" class="timer-bar" style="width:100%"></div></div>
        <div class="timer-label" id="t-lbl">35s</div>
        <div id="mimic-feed" class="live-feed" style="margin-top:8px"></div>
      </div>
      ${scoreboardHTML()}
    </div>
  `);

  $id('target-player').appendChild(audioPlayerWidget(targetBuf,'Target Sound'));

  setupRecBtn('btn-mm','mm-tmr',10, buf => {
    if (!buf) return;
    G.myMimicBuf = buf;
    $id('mm-prev').classList.remove('hidden');
    $id('mm-player').innerHTML='';
    $id('mm-player').appendChild(audioPlayerWidget(buf,'Your Mimic'));

    $id('btn-send-mm').onclick = async () => {
      if (G.mimicSubmitted) return;
      G.mimicSubmitted = true;
      const btn = $id('btn-send-mm');
      if (btn) { btn.disabled=true; btn.textContent='Submitting…'; }
      try {
        const b64 = G.audio.toBase64(buf);
        G.socket.emit('mimic_audio', { audioBase64: b64 });
        $id('mm-prev').classList.add('hidden');
        $id('mm-submitted').classList.remove('hidden');
      } catch(e) {
        toast('Failed to submit','error');
        G.mimicSubmitted = false;
        if (btn) { btn.disabled=false; btn.textContent='Submit Mimic 🎯'; }
      }
    };

    $id('btn-remm').onclick = () => {
      G.myMimicBuf = null;
      $id('mm-prev').classList.add('hidden');
      $id('mm-player').innerHTML='';
      const b = $id('btn-mm');
      if (b) { b.dataset.state='idle'; b.querySelector('.rec-label').textContent='Hold to Record'; }
    };
  });

  const left = G.room.phaseEndEpoch ? Math.max(0,(G.room.phaseEndEpoch-Date.now())/1000) : 35;
  startClientTimer(left, $id('t-bar'), $id('t-lbl'));
}

// ── CREATOR: Waiting while others mimic ───────────────────────────────────
function showCreatorWaiting() {
  const amHost = G.room?.hostId === G.myId;
  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="role-banner creator">🔊 Your sound is out there!</div>
      <div class="card card-glow-green text-center">
        <h2>Players are mimicking…</h2>
        <p>Listen to each mimic as they come in!</p>
        <div class="spinner" style="margin:12px auto"></div>
      </div>
      <div class="card">
        <h3>Mimics received:</h3>
        <div id="mimic-feed" class="live-feed" style="gap:10px;display:flex;flex-direction:column"></div>
      </div>
      ${scoreboardHTML()}
      ${amHost ? `<button id="btn-force-lobby" class="btn-ghost btn-full" style="margin-top:8px;font-size:.82rem;color:var(--text3)">↩ Abort & Return to Lobby</button>` : ''}
    </div>
  `);
  if (amHost) {
    const b = $id('btn-force-lobby');
    if (b) b.onclick = () => { if (confirm('Abort this round and return everyone to the lobby?')) G.socket.emit('force_lobby'); };
  }
}

// ── Waiting generic ───────────────────────────────────────────────────────
function showWaiting(msg, sub) {
  const amHost = G.room?.hostId === G.myId;
  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="wait-center">
        <div class="wait-icon">✨</div>
        <h2>${esc(msg)}</h2>
        ${sub ? `<p>${esc(sub)}</p>` : ''}
        <div class="spinner"></div>
      </div>
      ${scoreboardHTML()}
      ${amHost ? `<button id="btn-force-lobby" class="btn-ghost btn-full" style="margin-top:8px;font-size:.82rem;color:var(--text3)">↩ Abort & Return to Lobby</button>` : ''}
    </div>
  `);
  if (amHost) {
    const b = $id('btn-force-lobby');
    if (b) b.onclick = () => { if (confirm('Abort this round and return everyone to the lobby?')) G.socket.emit('force_lobby'); };
  }
}

// ── Round result ──────────────────────────────────────────────────────────
async function showRoundResult() {
  const room   = G.room;
  const result = room.roundResult;
  if (!result) return;
  const amHost = room.hostId === G.myId;

  if (room.mode === 'reverse') {
    const { celebrity, speakerName, stumped, guesses, scores } = result;
    render(`
      <div class="screen">
        ${roundBadge()}
        <div class="card ${stumped ? 'card-glow-pink' : 'card-glow-green'}" style="text-align:center">
          <div style="font-size:2.5rem">${stumped ? '😈' : '🎉'}</div>
          <h2>${stumped ? `${esc(speakerName)} stumped everyone!` : 'Correct guesses!'}</h2>
          <p>The celebrity was:</p>
          <div class="celeb-big">${esc(celebrity)}</div>
        </div>
        <div class="card">
          <h3>Guesses</h3>
          ${guesses.length ? guesses.map(g => `
            <div class="guess-result-row ${g.correct?'correct':'wrong'}">
              <span class="gr-name">${esc(g.name)}</span>
              <span class="gr-guess">${esc(g.guess)}</span>
              <span class="gr-pts">${g.points > 0 ? '+'+g.points : '—'}</span>
            </div>`).join('') : '<p style="color:var(--text3)">Nobody guessed in time.</p>'}
          ${stumped ? `<div class="guess-result-row correct"><span class="gr-name">🎙️ ${esc(speakerName)}</span><span class="gr-guess">Stumped the room!</span><span class="gr-pts">+80</span></div>` : ''}
        </div>
        ${scoreboardHTML()}
        ${amHost ? `<button id="btn-next" class="btn-primary btn-full">Next Round ➡️</button>` : '<p class="text-center" style="color:var(--text3)">Waiting for host…</p>'}
      </div>
    `);
  } else {
    // Noise mimic result
    const { creatorName, ranking } = result;
    render(`
      <div class="screen">
        ${roundBadge()}
        <div class="card text-center card-glow-green">
          <div style="font-size:2rem">🔊</div>
          <h2>Mimic Results</h2>
          <p>Created by <strong>${esc(creatorName)}</strong></p>
        </div>
        <div id="mimic-result-list" class="card" style="gap:10px;display:flex;flex-direction:column"></div>
        ${scoreboardHTML()}
        ${amHost ? `<button id="btn-next" class="btn-primary btn-full">Next Round ➡️</button>` : '<p class="text-center" style="color:var(--text3)">Waiting for host…</p>'}
      </div>
    `);

    const list = $id('mimic-result-list');
    const RANK_ICONS = ['🥇','🥈','🥉'];

    for (const r of ranking) {
      const row = document.createElement('div');
      row.className = 'mimic-row';
      row.innerHTML = `
        <div class="mimic-header">
          <span class="mimic-rank">${RANK_ICONS[r.rank-1] || `#${r.rank}`}</span>
          <span class="mimic-name">${esc(r.name)}</span>
          <span class="mimic-pct" style="color:${r.score>=75?'var(--green)':r.score>=50?'var(--orange)':'var(--red)'}">${r.score}%</span>
          <span class="mimic-pts">+${r.points}</span>
        </div>
        <div class="mimic-comment">${esc(r.commentary)}</div>
      `;

      // Add audio player if audio available
      if (room.roundResult?.mimics?.[r.playerId]?.audio) {
        try {
          const buf = await G.audio.fromBase64(room.roundResult.mimics[r.playerId].audio);
          row.appendChild(audioPlayerWidget(buf, `${r.name}'s mimic`));
        } catch(e) { console.error(e); }
      }

      list.appendChild(row);
    }
  }

  if (amHost) {
    const nb = $id('btn-next');
    if (nb) nb.onclick = () => G.socket.emit('next_round');
  }
}

// ── Final podium ──────────────────────────────────────────────────────────
function showPodium() {
  const { podium, allScores } = G.room.roundResult;
  launchConfetti();
  const [first, second, third] = podium;

  render(`
    <div class="screen">
      <h1 class="text-center gradient-text">Game Over! 🏆</h1>
      <div class="podium">
        ${second ? `
        <div class="podium-place">
          <div class="podium-trophy">🥈</div>
          <div class="podium-name">${esc(second.name)}</div>
          <div class="podium-score">${second.score}</div>
          <div class="podium-block silver"></div>
        </div>` : '<div class="podium-place"></div>'}
        ${first ? `
        <div class="podium-place">
          <div class="podium-trophy">🥇</div>
          <div class="podium-name">${esc(first.name)}</div>
          <div class="podium-score">${first.score}</div>
          <div class="podium-block gold"></div>
        </div>` : ''}
        ${third ? `
        <div class="podium-place">
          <div class="podium-trophy">🥉</div>
          <div class="podium-name">${esc(third.name)}</div>
          <div class="podium-score">${third.score}</div>
          <div class="podium-block bronze"></div>
        </div>` : '<div class="podium-place"></div>'}
      </div>
      <div class="card">
        <h3>Full Leaderboard</h3>
        <div class="player-list">
          ${allScores.map((p,i) => `
            <div class="player-row ${p.id===G.myId?'me':''}">
              <span style="font-weight:900;font-size:1.1rem;min-width:28px">${i+1}</span>
              <span class="player-name">${esc(p.name)}</span>
              <span class="player-score">${p.score}</span>
            </div>`).join('')}
        </div>
      </div>
      ${G.room.hostId === G.myId ? `
      <div class="flex-row">
        <button id="btn-rematch" class="btn-primary">🔁 Rematch</button>
        <button id="btn-lobby" class="btn-ghost">🏠 Lobby</button>
      </div>` : '<p class="text-center" style="color:var(--text3)">Waiting for host…</p>'}
    </div>
  `);

  if (G.room.hostId === G.myId) {
    $id('btn-rematch').onclick = () => G.socket.emit('play_again');
    $id('btn-lobby').onclick   = () => G.socket.emit('back_to_lobby');
  }
}

// ── Scoring / analyzing screen ────────────────────────────────────────────
function showScoring() {
  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="wait-center">
        <div style="font-size:3rem">🔬</div>
        <h2>Analyzing mimics…</h2>
        <p>Comparing audio fingerprints</p>
        <div class="spinner"></div>
      </div>
    </div>
  `);
}

// ═══════════════════════════════════════════════════════════════
// MAIN RENDER ROUTER
// ═══════════════════════════════════════════════════════════════
function renderPhase() {
  const room = G.room;
  if (!room) return showLanding();

  const spId  = room.speakerOrder?.[room.speakerIdx];
  G.isSpeaker = G.isSpeaker; // set by server event
  G.isCreator = G.isCreator;

  switch (room.phase) {
    case 'lobby':           return showLobby();
    case 'speaker_cat':     return G.isSpeaker ? showSpeakerCatSelect()  : showWaiting('Speaker is choosing a category…','Get ready to guess!');
    case 'speaker_celeb':   return G.isSpeaker ? showSpeakerCelebSelect(G.celebOptions) : showWaiting('Speaker is choosing a celebrity…','');
    case 'speaker_record':  return G.isSpeaker ? showSpeakerRecord(room._celeb||'')     : showWaiting('Speaker is recording…','You’ll hear reversed audio soon!');
    case 'guessing':
      if (G.isSpeaker) return showSpeakerWaiting();
      if (G.speakerBuf) return showGuesserTurn(G.speakerBuf);
      return showWaiting('Loading reversed audio…','');
    case 'noise_record':    return G.isCreator ? showNoiseCreatorRecord() : showWaiting('Noise creator is recording a sound…','Listen carefully — you’ll need to mimic it!');
    case 'noise_mimic':
      if (G.isCreator) return showCreatorWaiting();
      if (G.creatorBuf) return showNoiseMimicTurn(G.creatorBuf);
      return showWaiting('Loading target sound…','');
    case 'noise_scoring':   return showScoring();
    case 'round_result':    return showRoundResult();
    case 'final':           return showPodium();
    default:                return showWaiting('Loading…','');
  }
}

// ═══════════════════════════════════════════════════════════════
// SOCKET SETUP
// ═══════════════════════════════════════════════════════════════
function initSocket(onReady) {
  const s = io({ transports: ['websocket','polling'] });
  G.socket = s;

  s.on('connect', () => {
    removeDisconnectOverlay();
    // Auto-rejoin if session stored
    if (SESSION.id && SESSION.room) {
      s.emit('rejoin', { playerId: SESSION.id, roomCode: SESSION.room });
    }
    if (onReady) { onReady(); onReady = null; }
  });

  s.on('disconnect', () => {
    stopClientTimer();
    showDisconnectOverlay();
  });

  s.on('reconnect', () => {
    removeDisconnectOverlay();
    toast('Reconnected!','success');
  });

  // ── Room events ──────────────────────────────────────────────
  s.on('room_created', ({ playerId, room }) => {
    G.myId   = playerId;
    G.myName = room.players.find(p=>p.id===playerId)?.name || '';
    G.room   = room;
    G.isSpeaker = false; G.isCreator = false;
    SESSION.save(playerId, G.myName, room.code);
    renderPhase();
  });

  s.on('room_joined', ({ playerId, room }) => {
    G.myId   = playerId;
    G.myName = room.players.find(p=>p.id===playerId)?.name || '';
    G.room   = room;
    SESSION.save(playerId, G.myName, room.code);
    renderPhase();
  });

  s.on('rejoin_success', ({ playerId, room }) => {
    G.myId = playerId;
    G.room = room;
    G.myName = room.players.find(p=>p.id===playerId)?.name || SESSION.name || '';
    // Restore role flags from room state
    const spId = room.speakerOrder?.[room.speakerIdx];
    G.isSpeaker = (spId === playerId) && ['speaker_cat','speaker_celeb','speaker_record','guessing'].includes(room.phase);
    G.isCreator = (spId === playerId) && ['noise_record','noise_mimic'].includes(room.phase);

    // Host refresh prompt — give host a chance to leave instead of auto-rejoining
    if (room.hostId === playerId && room.phase === 'lobby') {
      const stay = confirm('You refreshed as the room host.\n\nStay as host → OK\nLeave room → Cancel');
      if (!stay) {
        G.socket.emit('leave_room');
        SESSION.clear();
        G.room = null;
        showLanding();
        return;
      }
    }

    toast('Rejoined! ✅','success');
    renderPhase();
  });

  s.on('rejoin_failed', ({ msg }) => {
    SESSION.clear();
    toast(msg||'Session expired','error');
    showLanding();
  });

  s.on('room_snapshot', room => {
    G.room = room;
    renderPhase();
  });

  s.on('join_error', ({ msg }) => {
    toast(msg,'error');
  });

  s.on('error_msg', ({ msg }) => { toast(msg,'error'); });

  // ── Private role notifications ───────────────────────────────
  s.on('you_are_speaker', () => {
    G.isSpeaker = true; G.isCreator = false;
    if (G.room?.phase === 'speaker_cat') showSpeakerCatSelect();
  });

  s.on('you_are_creator', () => {
    G.isCreator = true; G.isSpeaker = false;
    if (G.room?.phase === 'noise_record') showNoiseCreatorRecord();
  });

  s.on('celeb_options', ({ options }) => {
    G.celebOptions = options;
    if (G.room?.phase === 'speaker_celeb') showSpeakerCelebSelect(options);
  });

  s.on('celeb_confirmed', ({ celeb }) => {
    G.room._celeb = celeb;
    if (G.room?.phase === 'speaker_record') showSpeakerRecord(celeb);
  });

  // ── Audio delivery ───────────────────────────────────────────
  s.on('reversed_audio', async ({ audioBase64 }) => {
    if (G.isSpeaker) return;
    try {
      toast('Reversed audio incoming… 🔀', 'info');
      G.speakerBuf = await G.audio.fromBase64(audioBase64);
      showGuesserTurn(G.speakerBuf);
    } catch(e) {
      console.error('reversed_audio decode failed:', e);
      toast('Failed to load reversed audio — ask speaker to re-record', 'error');
    }
  });

  s.on('creator_audio', async ({ audioBase64 }) => {
    if (G.isCreator) return;
    try {
      toast('Target sound received — loading…', 'info');
      G.creatorBuf = await G.audio.fromBase64(audioBase64);
      showNoiseMimicTurn(G.creatorBuf);
    } catch(e) {
      console.error('creator_audio decode failed:', e);
      toast('Failed to load the sound — ask creator to re-send', 'error');
    }
  });

  // ── Live guess feed ──────────────────────────────────────────
  s.on('guess_in', ({ name, correct, firstCorrect, points }) => {
    const msg = correct
      ? `✅ <strong>${esc(name)}</strong> got it! ${firstCorrect?'+100':'+'+(points||60)} pts`
      : `❌ <strong>${esc(name)}</strong> guessed wrong`;
    addFeedItem(msg, correct?'correct':'wrong');
    if (correct) toast(`${name} got it!`, 'success');
  });

  s.on('mimic_in', async ({ name, audioBase64 }) => {
    const feed = $id('mimic-feed');
    if (feed) {
      const d = document.createElement('div');
      d.className = 'feed-item info';
      d.style.flexDirection = 'column';
      d.style.alignItems = 'flex-start';
      d.style.gap = '6px';
      d.innerHTML = `<span>${esc(name)} submitted their mimic ✓</span>`;
      if (audioBase64 && G.audio) {
        try {
          const buf = await G.audio.fromBase64(audioBase64);
          d.appendChild(audioPlayerWidget(buf, `${name}'s mimic`));
        } catch(e) { console.error('mimic_in decode:', e); }
      }
      feed.appendChild(d);
    }
  });

  // ── Kick / Leave events ──────────────────────────────────────
  s.on('kicked', ({ msg }) => {
    SESSION.clear();
    G.room = null;
    toast(msg || 'You were kicked from the room.', 'error');
    showLanding();
  });

  // ── Player events ────────────────────────────────────────────
  s.on('player_reconnected', ({ name }) => toast(`${name} reconnected ✅`,'info'));
  s.on('player_disconnected', ({ name }) => toast(`${name} disconnected 📵`,'error'));

  // ── Visibility change reconnection (iOS Safari fix) ──────────
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !s.connected) {
      s.connect();
    }
  });
}

// ── Disconnect overlay ────────────────────────────────────────────────────
function showDisconnectOverlay() {
  if ($id('dc-overlay')) return;
  const el = document.createElement('div');
  el.id = 'dc-overlay';
  el.innerHTML = `
    <div class="dc-card">
      <div style="font-size:2rem">📵</div>
      <h3>Connection lost</h3>
      <p>Your spot is saved for 5 minutes. Reconnecting…</p>
      <div class="spinner" style="margin:0 auto"></div>
    </div>`;
  document.body.appendChild(el);
}

function removeDisconnectOverlay() {
  $id('dc-overlay')?.remove();
}

// ═══════════════════════════════════════════════════════════════
// ENTRY POINTS
// ═══════════════════════════════════════════════════════════════
async function doCreate(name) {
  if (!name) { toast('Enter your name!','error'); return; }
  await ensureAudio();
  if (!G.socket) initSocket();
  G.myName = name;
  G.isSpeaker = false; G.isCreator = false;
  G.socket.emit('create_room', { playerName: name });
}

async function doJoin(name, code) {
  if (!name) { toast('Enter your name!','error'); return; }
  if (!code || code.length < 4) { toast('Enter a valid room code!','error'); return; }
  await ensureAudio();
  if (!G.socket) initSocket();
  G.myName = name;
  G.isSpeaker = false; G.isCreator = false;
  G.socket.emit('join_room', { roomCode: code, playerName: name });
}

async function ensureAudio() {
  if (G.audio) return;
  try {
    G.audio = new AudioManager();
    await G.audio.init();
    // Unlock AudioContext on any user gesture (critical for iOS Safari)
    const unlock = () => {
      if (G.audio?.ctx?.state === 'suspended') G.audio.ctx.resume().catch(() => {});
    };
    document.addEventListener('touchstart', unlock, { passive: true });
    document.addEventListener('click',      unlock, { passive: true });
  } catch(e) {
    toast('Microphone access required! Please allow it and try again.','error');
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  // Check URL for room code auto-fill
  const urlRoom = new URLSearchParams(location.search).get('room');

  // Try silent auto-rejoin
  if (SESSION.id && SESSION.room) {
    ensureAudio().then(() => {
      initSocket(() => {}); // rejoin is sent inside 'connect' handler
    }).catch(() => showLanding());
  } else {
    showLanding();
  }

  if (urlRoom) {
    const el = $id('j-code');
    if (el) el.value = urlRoom;
  }
});
