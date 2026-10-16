'use strict';

// ═══════════════════════════════════════════════════════════════
// SESSION PERSISTENCE
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
  room:         null,
  // roles
  isSpeaker:    false,
  isCreator:    false,
  isImposter:   false,
  // audio buffers — Mode 1
  speakerBuf:   null,
  mimicBuf:     null,
  // audio buffers — Mode 2
  creatorBuf:   null,
  myMimicBuf:   null,
  // Mode 3 — Voice Disguise
  _imposterPrompt:  null,
  imposterEffect:   null,
  imposterAudioBuf: null,
  imposterVoted:    false,
  _myImposterVote:  null,
  // Mode 4 — Broken Telephone
  telephoneListenBuf:     null,
  telephoneChainIdx:      -1,
  _telephonePrompt:       null,
  myTelephoneSubmitted:   false,
  telephoneVotedAccurate: false,
  telephoneVotedBlunder:  false,
  _myTelAccuratePid:      null,
  _myTelBlunderPid:       null,
  // Mode 5 — Word Imposter
  wiRole:           null,
  wiWord:           null,
  wiClueSubmitted:  false,
  wiVoted:          false,
  wiMyVotePid:      null,
  wiGuessSubmitted: false,
  _wiLastPhase:     null,
  // Mode 1 name hint
  nameHint:     null,
  // phase timers
  timerHandle:  null,
  timerEnd:     null,
  timerEl:      null,
  timerBarEl:   null,
  // ui state
  guessSubmitted: false,
  mimicSubmitted: false,
  celebOptions:   [],
  _lastRound:     0,
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
// DSP EFFECTS  (OfflineAudioContext, client-side)
// ═══════════════════════════════════════════════════════════════
async function applyEffect(audioBuf, effect) {
  if (!audioBuf) return null;
  const sr  = audioBuf.sampleRate;
  const ch  = audioBuf.numberOfChannels;
  const len = audioBuf.length;

  if (effect === 'helium') {
    const rate   = 1.75;
    const outLen = Math.max(1, Math.floor(len / rate));
    const off    = new OfflineAudioContext(ch, outLen, sr);
    const src    = off.createBufferSource();
    src.buffer   = audioBuf;
    src.playbackRate.value = rate;
    src.connect(off.destination);
    src.start(0);
    return off.startRendering();
  }

  if (effect === 'demon') {
    const rate   = 0.55;
    const outLen = Math.min(Math.floor(len / rate), sr * 12);
    const off    = new OfflineAudioContext(ch, outLen, sr);
    const src    = off.createBufferSource();
    src.buffer   = audioBuf;
    src.playbackRate.value = rate;
    const ws     = off.createWaveShaper();
    const curve  = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i * 2 / 255) - 1;
      curve[i] = Math.sign(x) * (1 - Math.exp(-3 * Math.abs(x)));
    }
    ws.curve = curve;
    src.connect(ws); ws.connect(off.destination);
    src.start(0);
    return off.startRendering();
  }

  if (effect === 'robot') {
    const off  = new OfflineAudioContext(ch, len, sr);
    const src  = off.createBufferSource();
    src.buffer = audioBuf;
    const filt = off.createBiquadFilter();
    filt.type  = 'bandpass';
    filt.frequency.value = 1000;
    filt.Q.value = 12;
    src.connect(filt); filt.connect(off.destination);
    src.start(0);
    return off.startRendering();
  }

  if (effect === 'walkie') {
    const off  = new OfflineAudioContext(ch, len, sr);
    const src  = off.createBufferSource();
    src.buffer = audioBuf;
    const hp   = off.createBiquadFilter();
    hp.type    = 'highpass'; hp.frequency.value = 300;
    const lp   = off.createBiquadFilter();
    lp.type    = 'lowpass';  lp.frequency.value = 3400;
    const ws   = off.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i * 2 / 255) - 1;
      curve[i] = Math.tanh(x * 2.5) / Math.tanh(2.5);
    }
    ws.curve = curve;
    src.connect(hp); hp.connect(lp); lp.connect(ws); ws.connect(off.destination);
    src.start(0);
    return off.startRendering();
  }

  return audioBuf;
}

function effectLabel(effect) {
  return { helium:'Helium Voice 🎈', demon:'Demon Voice 😈', robot:'Robot Voice 🤖', walkie:'Walkie Talkie 📻' }[effect] || effect;
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

function startClientTimer(totalSec, elBar, elLabel) {
  clearInterval(G.timerHandle);
  G.timerEnd   = Date.now() + totalSec * 1000;
  G.timerEl    = elLabel;
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

function audioPlayerWidget(audioBuf, label) {
  const wrap   = document.createElement('div');
  wrap.className = 'audio-player';
  const canvas  = document.createElement('canvas');
  canvas.className = 'waveform';
  canvas.width = 180; canvas.height = 36;
  const playBtn = document.createElement('button');
  playBtn.className = 'play-btn';
  playBtn.textContent = '▶';
  const lbl = document.createElement('span');
  lbl.className = 'audio-label';
  lbl.textContent = label || '';
  wrap.appendChild(playBtn); wrap.appendChild(canvas); wrap.appendChild(lbl);

  const ctx  = canvas.getContext('2d');
  const data = audioBuf.getChannelData(0);
  const W = canvas.width, H = canvas.height;
  const step = Math.ceil(data.length / W);
  ctx.fillStyle = 'rgba(0,212,255,.05)'; ctx.fillRect(0,0,W,H);
  ctx.strokeStyle = '#00d4ff'; ctx.lineWidth = 1; ctx.beginPath();
  for (let x = 0; x < W; x++) {
    let peak = 0;
    for (let j = 0; j < step; j++) { const v = Math.abs(data[Math.min(x*step+j,data.length-1)]||0); if (v>peak) peak=v; }
    const h = peak*(H/2);
    if (x===0) ctx.moveTo(x,H/2-h); else ctx.lineTo(x,H/2-h);
  }
  for (let x = W-1; x >= 0; x--) {
    let peak = 0;
    for (let j = 0; j < step; j++) { const v = Math.abs(data[Math.min(x*step+j,data.length-1)]||0); if (v>peak) peak=v; }
    ctx.lineTo(x, H/2+peak*(H/2));
  }
  ctx.closePath(); ctx.fillStyle = 'rgba(0,212,255,.2)'; ctx.fill(); ctx.stroke();

  let src = null;
  playBtn.onclick = async () => {
    if (src) { try { src.stop(); } catch(e){} src=null; playBtn.textContent='▶'; return; }
    playBtn.textContent = '⏹'; playBtn.disabled = true;
    src = await G.audio.play(audioBuf, () => { src=null; playBtn.textContent='▶'; playBtn.disabled=false; });
    playBtn.disabled = false;
    if (!src) playBtn.textContent = '▶';
  };
  return wrap;
}

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

function launchConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  if (!canvas) return;
  const ctx  = canvas.getContext('2d');
  canvas.width = window.innerWidth; canvas.height = window.innerHeight;
  const colors = ['#ffd700','#ff006e','#00d4ff','#39ff14','#bf00ff','#ff6b00'];
  const parts  = Array.from({ length: 180 }, () => ({
    x: Math.random()*canvas.width, y: -20-Math.random()*100,
    vx:(Math.random()-.5)*4, vy:Math.random()*3+1.5,
    w:Math.random()*10+5, h:Math.random()*6+3,
    color:colors[Math.floor(Math.random()*colors.length)],
    rot:Math.random()*360, rv:(Math.random()-.5)*8,
  }));
  let raf;
  function draw() {
    ctx.clearRect(0,0,canvas.width,canvas.height);
    let alive = false;
    for (const p of parts) {
      p.x+=p.vx; p.y+=p.vy; p.vy+=.08; p.rot+=p.rv;
      if (p.y < canvas.height+20) alive=true;
      ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rot*Math.PI/180);
      ctx.fillStyle=p.color; ctx.fillRect(-p.w/2,-p.h/2,p.w,p.h); ctx.restore();
    }
    if (alive) { raf=requestAnimationFrame(draw); }
    else ctx.clearRect(0,0,canvas.width,canvas.height);
  }
  draw();
  setTimeout(()=>{ cancelAnimationFrame(raf); ctx.clearRect(0,0,canvas.width,canvas.height); },7000);
}

// ═══════════════════════════════════════════════════════════════
// SCREENS
// ═══════════════════════════════════════════════════════════════

// ── Landing ───────────────────────────────────────────────────
function showLanding() {
  render(`
    <div class="screen">
      <div class="logo">
        <div class="logo-icon">🎤</div>
        <h1><span class="gradient-text">EchoClash</span></h1>
        <p class="logo-sub">Party Voice Game</p>
        <div class="mode-pills">
          <span class="mode-pill">🔀 Reverse Voice</span>
          <span class="mode-pill">🔊 Noise Mimic</span>
          <span class="mode-pill">🕵️ Voice Disguise</span>
          <span class="mode-pill">📞 Broken Telephone</span>
          <span class="mode-pill">🕵🏽 Word Imposter</span>
        </div>
      </div>

      <div class="landing-tabs">
        <button id="tab-create" class="tab-btn active">Create Room</button>
        <button id="tab-join"   class="tab-btn">Join Room</button>
      </div>

      <div id="panel-create" class="card card-glow-blue">
        <div class="field">
          <label>Your Name</label>
          <input id="c-name" type="text" placeholder="Enter your name" maxlength="20" autocomplete="off" />
        </div>
        <button id="btn-create" class="btn-primary btn-full btn-large">Create Room 🚀</button>
      </div>

      <div id="panel-join" class="card" style="display:none">
        <div class="field">
          <label>Your Name</label>
          <input id="j-name" type="text" placeholder="Enter your name" maxlength="20" autocomplete="off" />
        </div>
        <div class="field">
          <label>Room Code</label>
          <input id="j-code" type="text" placeholder="e.g. ABCD" maxlength="6" autocomplete="off"
            style="text-transform:uppercase;letter-spacing:4px;font-weight:800;font-size:1.3rem;text-align:center" />
        </div>
        <button id="btn-join" class="btn-danger btn-full btn-large">Join Room 🎉</button>
      </div>
    </div>
  `);

  $id('c-name').value = SESSION.name || '';
  $id('j-name').value = SESSION.name || '';

  $id('tab-create').onclick = () => {
    $id('tab-create').classList.add('active'); $id('tab-join').classList.remove('active');
    $id('panel-create').style.display = ''; $id('panel-join').style.display = 'none';
  };
  $id('tab-join').onclick = () => {
    $id('tab-join').classList.add('active'); $id('tab-create').classList.remove('active');
    $id('panel-join').style.display = ''; $id('panel-create').style.display = 'none';
    setTimeout(() => $id('j-name').focus(), 50);
  };

  $id('btn-create').onclick = () => doCreate($id('c-name').value.trim());
  $id('btn-join').onclick   = () => doJoin($id('j-name').value.trim(), $id('j-code').value.trim().toUpperCase());

  $id('j-code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });
  $id('c-name').addEventListener('keydown', e => { if (e.key==='Enter') doCreate($id('c-name').value.trim()); });
  $id('j-code').addEventListener('keydown', e => { if (e.key==='Enter') doJoin($id('j-name').value.trim(),$id('j-code').value.trim().toUpperCase()); });

  if (SESSION.id) {
    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn-ghost btn-sm';
    clearBtn.style.cssText = 'margin-top:4px;font-size:.78rem;color:var(--text3);width:100%;max-width:520px';
    clearBtn.textContent = '✕ Clear saved session & start fresh';
    clearBtn.onclick = () => { SESSION.clear(); G.socket?.disconnect(); G.socket=null; G.audio=null; showLanding(); };
    $app().appendChild(clearBtn);
  }
}

// ── Invite join (when opened via link ?room=CODE) ─────────────
function showInviteJoin(roomCode) {
  render(`
    <div class="screen">
      <div class="logo" style="padding-bottom:0">
        <div class="logo-icon">🎤</div>
        <h1><span class="gradient-text">EchoClash</span></h1>
      </div>

      <div class="card card-glow-blue invite-card">
        <div class="invite-header">
          <span class="invite-icon">🎉</span>
          <h2>You're invited!</h2>
          <p>Room <strong>${esc(roomCode)}</strong> is waiting for you</p>
        </div>
        <div class="room-code-big" style="font-size:2.4rem;letter-spacing:8px">${esc(roomCode)}</div>
        <div class="field">
          <label>Your Name</label>
          <input id="invite-name" type="text" placeholder="What should we call you?" maxlength="20" autocomplete="off" />
        </div>
        <button id="btn-invite-join" class="btn-primary btn-full btn-large">Join Room 🚀</button>
        <button id="btn-invite-back" class="btn-ghost btn-full" style="margin-top:4px">← Back to Home</button>
      </div>
    </div>
  `);

  const nameEl = $id('invite-name');
  nameEl.value = SESSION.name || '';
  setTimeout(() => nameEl.focus(), 50);

  const doJoinInvite = () => {
    const name = nameEl.value.trim();
    if (!name) { toast('Enter your name!', 'error'); return; }
    doJoin(name, roomCode);
  };

  $id('btn-invite-join').onclick = doJoinInvite;
  nameEl.addEventListener('keydown', e => { if (e.key==='Enter') doJoinInvite(); });
  $id('btn-invite-back').onclick = () => {
    history.replaceState({}, '', location.pathname);
    showLanding();
  };
}

// ── Lobby ─────────────────────────────────────────────────────
function showLobby() {
  const room   = G.room;
  const amHost = room.hostId === G.myId;
  const me     = room.players.find(p => p.id === G.myId);
  const canStart = amHost && room.players.length >= 2;

  const modeLabel = { reverse:'🔀 Reverse Voice', noise:'🔊 Noise Mimic', imposter:'🕵️ Voice Disguise', telephone:'📞 Broken Telephone', word_imposter:'🕵🏽 Word Imposter' };

  render(`
    <div class="screen">
      <div class="logo" style="padding-bottom:0">
        <h1><span class="gradient-text">EchoClash</span></h1>
      </div>

      <div class="card text-center">
        <small>Share this code with friends!</small>
        <div class="room-code-big">${esc(room.code)}</div>
        <button id="btn-copy" class="btn-ghost btn-sm btn-full">📋 Copy Invite Link</button>
      </div>

      <div class="card">
        <h3>Players (${room.players.length}/8)</h3>
        <div class="player-list">
          ${room.players.map((p,i) => `
            <div class="player-row ${p.id===G.myId?'me':''} ${!p.connected?'disconnected':''}">
              ${avatarHTML(p.name,i)}
              <span class="player-name">${esc(p.name)} ${p.isHost?'<span class="player-host-badge">Host</span>':''}</span>
              <span class="player-ready ${p.ready||p.isHost?'is-ready':''}">${p.isHost?'👑':p.ready?'✅':'⏳'}</span>
              ${amHost&&!p.isHost?`<button class="btn-kick" data-id="${esc(p.id)}" data-name="${esc(p.name)}" title="Kick">🚫</button>`:''}
            </div>`).join('')}
        </div>
        ${!amHost?`
          <button id="btn-ready" class="btn-${me?.ready?'ghost':'green'} btn-full">${me?.ready?'✅ Ready (click to unready)':'Mark as Ready ✅'}</button>
          <button id="btn-leave" class="btn-ghost btn-full" style="margin-top:6px;color:var(--red)">Leave Room 🚪</button>
        `:''}
      </div>

      ${amHost?`
      <div class="card card-glow-blue">
        <h3>Game Mode</h3>
        <div class="mode-grid">
          <button class="btn-mode-card ${room.mode==='reverse'?'active':''}" id="mode-rev">
            <span class="mode-card-icon">🔀</span>
            <span class="mode-card-name">Reverse Voice</span>
            <span class="mode-card-desc">Guess the celebrity from reversed audio</span>
          </button>
          <button class="btn-mode-card ${room.mode==='noise'?'active':''}" id="mode-noise">
            <span class="mode-card-icon">🔊</span>
            <span class="mode-card-name">Noise Mimic</span>
            <span class="mode-card-desc">Copy a sound — AI judges accuracy</span>
          </button>
          <button class="btn-mode-card ${room.mode==='imposter'?'active':''}" id="mode-imp">
            <span class="mode-card-icon">🕵️</span>
            <span class="mode-card-name">Voice Disguise</span>
            <span class="mode-card-desc">Imposter speaks disguised — guess who!</span>
          </button>
          <button class="btn-mode-card ${room.mode==='telephone'?'active':''}" id="mode-tel">
            <span class="mode-card-icon">📞</span>
            <span class="mode-card-name">Broken Telephone</span>
            <span class="mode-card-desc">Pass audio down the chain — how much distorts?</span>
          </button>
          <button class="btn-mode-card mode-card-wide ${room.mode==='word_imposter'?'active':''}" id="mode-wi">
            <span class="mode-card-icon">🕵🏽</span>
            <span class="mode-card-name">Word Imposter</span>
            <span class="mode-card-desc">Everyone has a secret word — one imposter has a different one. Find them!</span>
          </button>
        </div>
        ${room.mode==='word_imposter'?`
        <div class="card wi-settings">
          <h3>Word Imposter Settings</h3>
          <div class="field">
            <label>Number of Impostors</label>
            <div class="wi-count-btns">
              <button class="wi-count-btn ${room.wiImpostorCount===1?'active':''}" data-n="1">1</button>
              <button class="wi-count-btn ${room.wiImpostorCount===2?'active':''}" data-n="2">2</button>
              <button class="wi-count-btn ${room.wiImpostorCount===3?'active':''}" data-n="3">3</button>
            </div>
          </div>
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:.9rem;font-weight:600;color:var(--text2)">
            <input type="checkbox" id="wi-undercover" ${room.wiUndercoverMode?'checked':''} style="width:18px;height:18px;cursor:pointer" />
            Undercover Mode — one extra player gets a <em>blank</em> word
          </label>
        </div>`:''}
        <div class="field">
          <label>Rounds (2–20)</label>
          <input id="inp-rounds" type="number" min="2" max="20" value="${room.roundCount}" />
        </div>
        <button id="btn-start" class="btn-primary btn-full btn-large" ${canStart?'':'disabled'}>
          Start Game ▶ — ${modeLabel[room.mode]||room.mode}
        </button>
        ${room.players.length<2?'<small style="text-align:center;color:var(--text3)">Waiting for at least 1 more player…</small>':''}
        <button id="btn-host-leave" class="btn-ghost btn-full" style="margin-top:4px;color:var(--red);font-size:.85rem">Leave Room 🚪</button>
      </div>`:`
      <div class="card text-center">
        <p>Waiting for the host to start…</p>
        <p style="font-size:.82rem;color:var(--text3)">Current mode: ${modeLabel[room.mode]||room.mode}</p>
        <div class="spinner" style="margin:12px auto"></div>
      </div>`}
    </div>
  `);

  $id('btn-copy').onclick = () => {
    const url = `${location.origin}?room=${room.code}`;
    navigator.clipboard.writeText(url)
      .then(() => toast('Invite link copied! Share it with friends 🎉','success'))
      .catch(()  => toast(`Room code: ${room.code}`,'info'));
  };

  if (!amHost) {
    $id('btn-ready').onclick = () => G.socket.emit('set_ready', { ready: !me?.ready });
    $id('btn-leave').onclick = () => {
      if (confirm('Leave the room?')) {
        G.socket.emit('leave_room'); SESSION.clear(); G.room=null; showLanding();
      }
    };
  } else {
    $id('mode-rev').onclick   = () => G.socket.emit('host_set_mode', { mode:'reverse' });
    $id('mode-noise').onclick = () => G.socket.emit('host_set_mode', { mode:'noise' });
    $id('mode-imp').onclick   = () => G.socket.emit('host_set_mode', { mode:'imposter' });
    $id('mode-tel').onclick   = () => G.socket.emit('host_set_mode', { mode:'telephone' });
    $id('mode-wi').onclick    = () => G.socket.emit('host_set_mode', { mode:'word_imposter' });
    document.querySelectorAll('.wi-count-btn').forEach(b => {
      b.onclick = () => G.socket.emit('wi_set_impostors', { count: parseInt(b.dataset.n) });
    });
    const wiUc = $id('wi-undercover');
    if (wiUc) wiUc.onchange = () => G.socket.emit('wi_set_undercover', { enabled: wiUc.checked });
    $id('inp-rounds').onchange = () => {
      const v = parseInt($id('inp-rounds').value, 10);
      if (v>=2 && v<=20) G.socket.emit('host_set_rounds', { count:v });
    };
    $id('btn-start').onclick = () => G.socket.emit('host_start');
    $id('btn-host-leave').onclick = () => {
      if (confirm('Leave the room? Another player will become host.')) {
        G.socket.emit('leave_room'); SESSION.clear(); G.room=null; showLanding();
      }
    };
    document.querySelectorAll('.btn-kick').forEach(b => {
      b.onclick = () => {
        if (confirm(`Kick ${b.dataset.name}?`)) G.socket.emit('kick_player', { targetId: b.dataset.id });
      };
    });
  }
}

// ── MODE 1: Speaker — Category select ────────────────────────
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

// ── MODE 1: Speaker — Celebrity select ───────────────────────
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

// ── MODE 1: Speaker — Record ──────────────────────────────────
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
  setupRecBtn('btn-rec','rec-tmr',8, buf => {
    if (!buf) return;
    const rev = G.audio.reverse(G.audio.clone(buf));
    G.speakerBuf = rev;
    $id('prev-area').classList.remove('hidden');
    $id('prev-player').appendChild(audioPlayerWidget(rev,'Reversed'));
    $id('btn-send').onclick  = sendSpeakerAudio;
    $id('btn-rerec').onclick = () => {
      G.speakerBuf = null; $id('prev-area').classList.add('hidden'); $id('prev-player').innerHTML='';
      const b=$id('btn-rec'); if(b){b.dataset.state='idle';b.querySelector('.rec-label').textContent='Hold to Record';}
    };
  });
}

async function sendSpeakerAudio() {
  if (!G.speakerBuf) return;
  const btn = $id('btn-send');
  if (btn) { btn.disabled=true; btn.textContent='Sending…'; }
  try { G.socket.emit('speaker_audio', { audioBase64: G.audio.toBase64(G.speakerBuf) }); }
  catch(e) { toast('Failed to send audio','error'); if(btn){btn.disabled=false;btn.textContent='Send Reversed Audio ✈️';} }
}

// ── MODE 1: Speaker — Waiting for guesses ────────────────────
function showSpeakerWaiting() {
  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="role-banner speaker">🎙️ Speaker</div>
      ${G.room.selectedCat?`<div class="category-hint">Category: <strong>${esc(G.room.selectedCat==='mixed'?'Mixed — All Categories':G.room.selectedCat.charAt(0).toUpperCase()+G.room.selectedCat.slice(1))}</strong></div>`:''}
      <div class="wait-center">
        <div class="wait-icon">😈</div>
        <h2>Opponents are guessing…</h2>
        <p>Did you stump them?</p>
      </div>
      <div class="card">
        <h3>Live Guesses</h3>
        <div id="live-feed" class="live-feed"><div class="feed-item info">Waiting for guesses…</div></div>
      </div>
      <div class="card">
        <div class="timer-bar-wrap"><div id="t-bar" class="timer-bar" style="width:100%"></div></div>
        <div class="timer-label" id="t-lbl">45s</div>
      </div>
      ${scoreboardHTML()}
    </div>
  `);
  const left = G.room.phaseEndEpoch ? Math.max(0,(G.room.phaseEndEpoch-Date.now())/1000) : 45;
  startClientTimer(left, $id('t-bar'), $id('t-lbl'));
}

// ── MODE 1: Guesser — Guessing turn ──────────────────────────
function showGuesserTurn(audioBuf) {
  G.guessSubmitted = false; G.mimicBuf = null;
  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="role-banner guesser">👂 You are a Guesser</div>
      ${G.room.selectedCat?`<div class="category-hint">Category: <strong>${esc(G.room.selectedCat==='mixed'?'Mixed — All Categories':G.room.selectedCat.charAt(0).toUpperCase()+G.room.selectedCat.slice(1))}</strong></div>`:''}
      <div class="card card-glow-blue">
        <h3>Step 1 — Listen to reversed audio</h3>
        <div id="rev-player"></div>
        <p style="font-size:.82rem;color:var(--text3)">Play as many times as you need!</p>
        <div id="name-hint-reveal" class="name-hint-reveal" style="display:none"></div>
      </div>
      <div class="card">
        <h3>Step 2 — Mimic &amp; reverse it yourself</h3>
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

  $id('rev-player').appendChild(audioPlayerWidget(audioBuf,'Reversed'));
  if (G.nameHint) { const el=$id('name-hint-reveal'); if(el){el.textContent=G.nameHint;el.style.display='';} }

  setupRecBtn('btn-mimic','mimic-tmr',8, buf => {
    if (!buf) return;
    const rev = G.audio.reverse(G.audio.clone(buf));
    G.mimicBuf = rev;
    const mp=$id('mimic-player'); if(mp){mp.innerHTML='';mp.appendChild(audioPlayerWidget(rev,'Your Mimic Reversed'));}
    const pa=$id('mimic-prev'); if(pa) pa.classList.remove('hidden');
    try { G.socket.emit('mimic_audio', { audioBase64: G.audio.toBase64(rev) }); } catch(e) { console.error(e); }
    $id('btn-remimic').onclick = () => {
      G.mimicBuf=null; $id('mimic-prev').classList.add('hidden'); $id('mimic-player').innerHTML='';
      const b=$id('btn-mimic'); if(b){b.dataset.state='idle';b.querySelector('.rec-label').textContent='Hold to Mimic';}
    };
  });

  const inp=$id('inp-guess'), sub=$id('btn-submit-guess');
  inp.oninput  = () => { sub.disabled = !inp.value.trim()||G.guessSubmitted; };
  inp.onkeydown= e => { if(e.key==='Enter'&&!sub.disabled) submitGuess(); };
  sub.onclick  = submitGuess;

  const left = G.room.phaseEndEpoch ? Math.max(0,(G.room.phaseEndEpoch-Date.now())/1000) : 45;
  startClientTimer(left, $id('t-bar'), $id('t-lbl'));
}

function submitGuess() {
  if (G.guessSubmitted) return;
  const val = $id('inp-guess')?.value.trim();
  if (!val) return;
  G.guessSubmitted = true;
  const sub=$id('btn-submit-guess'); if(sub){sub.disabled=true;sub.textContent='Submitted! ⏳';}
  G.socket.emit('submit_guess', { guess: val });
}

function addFeedItem(html, cls) {
  const feed=$id('live-feed'); if(!feed) return;
  const d=document.createElement('div'); d.className=`feed-item ${cls}`; d.innerHTML=html;
  feed.appendChild(d); feed.scrollTop=feed.scrollHeight;
}

// ── MODE 2: Noise Creator — Record ───────────────────────────
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
          <li>Tap a spoon on glass</li><li>Crunch a chip bag</li>
          <li>Clicking a pen rapidly</li><li>Opening a soda can</li>
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
  setupRecBtn('btn-noise-rec','noise-tmr',5, buf => {
    if (!buf) return;
    G.creatorBuf = buf;
    $id('noise-prev').classList.remove('hidden');
    $id('noise-player').appendChild(audioPlayerWidget(buf,'Your Sound'));
    $id('btn-send-noise').onclick = sendCreatorAudio;
    $id('btn-renoise').onclick = () => {
      G.creatorBuf=null; $id('noise-prev').classList.add('hidden'); $id('noise-player').innerHTML='';
      const b=$id('btn-noise-rec'); if(b){b.dataset.state='idle';b.querySelector('.rec-label').textContent='Hold to Record';}
    };
  });
}

async function sendCreatorAudio() {
  if (!G.creatorBuf) { toast('No recording found — record first!','error'); return; }
  const btn=$id('btn-send-noise'); if(btn){btn.disabled=true;btn.textContent='Sending… ⏳';}
  try {
    const b64=G.audio.toBase64(G.creatorBuf);
    G.socket.emit('creator_audio',{audioBase64:b64},(ack)=>{
      if(ack?.ok){ toast('Sound sent to everyone! 📡','success'); }
      else if(ack?.err){ toast('Server rejected: '+ack.err,'error'); if(btn){btn.disabled=false;btn.textContent='Send to Players 📡';} }
    });
    setTimeout(()=>{ if(btn&&btn.disabled){btn.disabled=false;btn.textContent='Sent ✓';} },5000);
  } catch(e) {
    console.error('sendCreatorAudio:',e); toast('Failed to encode — try shorter recording','error');
    if(btn){btn.disabled=false;btn.textContent='Send to Players 📡';}
  }
}

// ── MODE 2: Noise Mimic — Mimic turn ─────────────────────────
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
  setupRecBtn('btn-mm','mm-tmr',5, buf => {
    if (!buf) return;
    G.myMimicBuf=buf;
    $id('mm-prev').classList.remove('hidden');
    $id('mm-player').innerHTML='';
    $id('mm-player').appendChild(audioPlayerWidget(buf,'Your Mimic'));
    $id('btn-send-mm').onclick = async () => {
      if (G.mimicSubmitted) return;
      G.mimicSubmitted=true;
      const btn=$id('btn-send-mm'); if(btn){btn.disabled=true;btn.textContent='Submitting…';}
      try {
        G.socket.emit('mimic_audio',{audioBase64:G.audio.toBase64(buf)});
        $id('mm-prev').classList.add('hidden'); $id('mm-submitted').classList.remove('hidden');
      } catch(e) {
        toast('Failed to submit','error'); G.mimicSubmitted=false;
        if(btn){btn.disabled=false;btn.textContent='Submit Mimic 🎯';}
      }
    };
    $id('btn-remm').onclick=()=>{
      G.myMimicBuf=null; $id('mm-prev').classList.add('hidden'); $id('mm-player').innerHTML='';
      const b=$id('btn-mm'); if(b){b.dataset.state='idle';b.querySelector('.rec-label').textContent='Hold to Record';}
    };
  });
  const left=G.room.phaseEndEpoch?Math.max(0,(G.room.phaseEndEpoch-Date.now())/1000):35;
  startClientTimer(left,$id('t-bar'),$id('t-lbl'));
}

// ── MODE 2: Creator — Waiting ─────────────────────────────────
function showCreatorWaiting() {
  const amHost=G.room?.hostId===G.myId;
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
      ${amHost?`<button id="btn-force-lobby" class="btn-ghost btn-full" style="margin-top:8px;font-size:.82rem;color:var(--text3)">↩ Abort &amp; Return to Lobby</button>`:''}
    </div>
  `);
  if (amHost) {
    const b=$id('btn-force-lobby');
    if(b) b.onclick=()=>{ if(confirm('Abort round and return to lobby?')) G.socket.emit('force_lobby'); };
  }
}

// ── MODE 3: Imposter — Record ─────────────────────────────────
function showImposterRecord(prompt, effect) {
  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="role-banner imposter">🕵️ You are the Imposter!</div>
      <div class="card card-glow-pink">
        <h3>Read this phrase aloud:</h3>
        <div class="imposter-prompt">${esc(prompt)}</div>
        <div class="effect-badge" style="margin:4px auto">${effectLabel(effect)}</div>
        <p style="font-size:.82rem;color:var(--text2)">Your voice will be disguised. Others must guess who you are!</p>
      </div>
      <div class="card">
        <div class="record-area">
          <button id="btn-imp-rec" class="btn-record" data-state="idle" style="display:flex">
            <span class="rec-icon">🎤</span><span class="rec-label">Hold to Record</span>
          </button>
          <div id="imp-tmr" class="rec-timer hidden"></div>
        </div>
        <div id="imp-prev" class="preview-area hidden">
          <p>🎭 Preview (${effectLabel(effect)}):</p>
          <div id="imp-player"></div>
          <div class="flex-row mt-8">
            <button id="btn-imp-send" class="btn-primary">Send to Everyone ✈️</button>
            <button id="btn-imp-rerec" class="btn-ghost">🔄 Re-record</button>
          </div>
        </div>
      </div>
      ${scoreboardHTML()}
    </div>
  `);

  setupRecBtn('btn-imp-rec','imp-tmr',8, async buf => {
    if (!buf) return;
    const btn=$id('btn-imp-send');
    if(btn){btn.disabled=true;btn.textContent='Applying effect…';}
    try {
      const processed = await applyEffect(buf, effect);
      G.imposterAudioBuf = processed;
      $id('imp-prev').classList.remove('hidden');
      $id('imp-player').innerHTML='';
      $id('imp-player').appendChild(audioPlayerWidget(processed, effectLabel(effect)));
      if(btn){btn.disabled=false;btn.textContent='Send to Everyone ✈️';}
      $id('btn-imp-send').onclick  = sendImposterAudio;
      $id('btn-imp-rerec').onclick = () => {
        G.imposterAudioBuf=null; $id('imp-prev').classList.add('hidden'); $id('imp-player').innerHTML='';
        const b=$id('btn-imp-rec'); if(b){b.dataset.state='idle';b.querySelector('.rec-label').textContent='Hold to Record';}
      };
    } catch(e) {
      console.error('applyEffect failed:',e); toast('Effect failed — try again','error');
      const b=$id('btn-imp-rec'); if(b){b.dataset.state='idle';b.querySelector('.rec-label').textContent='Hold to Record';}
    }
  });
}

async function sendImposterAudio() {
  if (!G.imposterAudioBuf) return;
  const btn=$id('btn-imp-send'); if(btn){btn.disabled=true;btn.textContent='Sending…';}
  try { G.socket.emit('imposter_audio',{audioBase64:G.audio.toBase64(G.imposterAudioBuf)}); }
  catch(e) { toast('Failed to send — try again','error'); if(btn){btn.disabled=false;btn.textContent='Send to Everyone ✈️';} }
}

// ── MODE 3: Non-imposter — Waiting ────────────────────────────
function showImposterWaiting() {
  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="role-banner guesser">👥 Get Ready to Guess!</div>
      <div class="wait-center">
        <div class="wait-icon">🎭</div>
        <h2>The imposter is recording…</h2>
        <p>You'll hear a disguised voice and must vote on who said it!</p>
        <div class="spinner"></div>
      </div>
      ${scoreboardHTML()}
    </div>
  `);
}

// ── MODE 3: Vote ──────────────────────────────────────────────
function showImposterVote() {
  const room=G.room;
  render(`
    <div class="screen imposter-vote-screen">
      ${roundBadge()}
      <div class="role-banner guesser">🔍 Who is the Imposter?</div>
      <div class="card card-glow-blue">
        <h3>Listen carefully…</h3>
        <div id="imp-vote-player"></div>
        <p style="font-size:.82rem;color:var(--text3)">Play multiple times — the voice is disguised!</p>
      </div>
      <div class="card">
        <h3>Vote — who do you think this is?</h3>
        <p style="font-size:.83rem;color:var(--text3)">Votes cast: <strong style="color:var(--text)">${room.votesIn||0} / ${room.players.length}</strong></p>
        <div class="imposter-vote-grid">
          ${room.players.map((p,i) => `
            <button class="vote-player-btn ${G._myImposterVote===p.id?'voted':''}"
              data-pid="${esc(p.id)}" ${G.imposterVoted?'disabled':''}>
              ${avatarHTML(p.name,i)}
              <span>${esc(p.name)}</span>
            </button>`).join('')}
        </div>
        ${G.imposterVoted?`<p class="text-center" style="color:var(--green);font-weight:700;margin-top:8px">✅ Vote cast! Waiting for others…</p>`:''}
      </div>
      <div class="card">
        <div class="timer-bar-wrap"><div id="t-bar" class="timer-bar" style="width:100%"></div></div>
        <div class="timer-label" id="t-lbl">40s</div>
      </div>
      ${scoreboardHTML()}
    </div>
  `);

  if (G.imposterAudioBuf) $id('imp-vote-player').appendChild(audioPlayerWidget(G.imposterAudioBuf,'Disguised Voice'));

  if (!G.imposterVoted) {
    document.querySelectorAll('.vote-player-btn').forEach(btn => {
      btn.onclick = () => {
        if (G.imposterVoted) return;
        G.imposterVoted     = true;
        G._myImposterVote   = btn.dataset.pid;
        G.socket.emit('cast_imposter_vote',{targetId:btn.dataset.pid});
        document.querySelectorAll('.vote-player-btn').forEach(b=>{
          b.disabled=true;
          if(b.dataset.pid===btn.dataset.pid) b.classList.add('voted');
        });
      };
    });
  }

  const left=room.phaseEndEpoch?Math.max(0,(room.phaseEndEpoch-Date.now())/1000):40;
  startClientTimer(left,$id('t-bar'),$id('t-lbl'));
}

// ── MODE 4: Telephone — My turn ───────────────────────────────
function showTelephoneMyTurn(chainIdx, chainLength, prompt, listenBuf) {
  G.myTelephoneSubmitted = false;
  render(`
    <div class="screen telephone-my-turn-screen">
      ${roundBadge()}
      <div class="role-banner telephone">📞 Your Turn! (${chainIdx+1} of ${chainLength})</div>
      ${chainIdx===0?`
        <div class="card card-glow-blue">
          <h3>Say this phrase aloud:</h3>
          <div class="imposter-prompt">${esc(prompt||'')}</div>
          <p style="font-size:.82rem;color:var(--text2)">Say it clearly — the next person will hear your recording!</p>
        </div>`:`
        <div class="card card-glow-blue">
          <h3>Listen to what was passed to you:</h3>
          <div id="tel-listen-player"></div>
          <p style="font-size:.82rem;color:var(--text2)">Repeat what you heard — no re-listening allowed after you record!</p>
        </div>`}
      <div class="card">
        <h3>Record your version:</h3>
        <div class="record-area">
          <button id="btn-tel-rec" class="btn-record" data-state="idle" style="display:flex">
            <span class="rec-icon">🎤</span><span class="rec-label">Hold to Record</span>
          </button>
          <div id="tel-rec-tmr" class="rec-timer hidden"></div>
        </div>
        <div id="tel-prev" class="preview-area hidden">
          <div id="tel-player"></div>
          <div class="flex-row mt-8">
            <button id="btn-tel-send" class="btn-primary">Pass It On 📡</button>
            <button id="btn-tel-rerec" class="btn-ghost">🔄 Re-record</button>
          </div>
        </div>
        <div id="tel-submitted" class="hidden text-center" style="color:var(--green);font-weight:700;padding:12px 0">✅ Passed on! Waiting for the chain…</div>
      </div>
      ${scoreboardHTML()}
    </div>
  `);

  if (chainIdx>0 && listenBuf) {
    const lp=$id('tel-listen-player');
    if(lp) lp.appendChild(audioPlayerWidget(listenBuf,'From previous player'));
  }

  setupRecBtn('btn-tel-rec','tel-rec-tmr',8, buf=>{
    if (!buf) return;
    $id('tel-prev').classList.remove('hidden');
    $id('tel-player').innerHTML='';
    $id('tel-player').appendChild(audioPlayerWidget(buf,'Your recording'));
    $id('btn-tel-send').onclick = async () => {
      if (G.myTelephoneSubmitted) return;
      G.myTelephoneSubmitted=true;
      const btn=$id('btn-tel-send'); if(btn){btn.disabled=true;btn.textContent='Sending…';}
      try {
        G.socket.emit('telephone_audio',{audioBase64:G.audio.toBase64(buf)});
        $id('tel-prev').classList.add('hidden'); $id('tel-submitted').classList.remove('hidden');
      } catch(e) {
        toast('Failed to send — try again','error'); G.myTelephoneSubmitted=false;
        if(btn){btn.disabled=false;btn.textContent='Pass It On 📡';}
      }
    };
    $id('btn-tel-rerec').onclick=()=>{
      $id('tel-prev').classList.add('hidden'); $id('tel-player').innerHTML='';
      const b=$id('btn-tel-rec'); if(b){b.dataset.state='idle';b.querySelector('.rec-label').textContent='Hold to Record';}
    };
  });
}

// ── MODE 4: Telephone — Waiting for others ────────────────────
function showTelephoneWaiting(currentName, remaining) {
  const room=G.room;
  const current=room.telephoneCurrentIdx||0;
  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="role-banner telephone">📞 Broken Telephone</div>
      <div class="card">
        <div class="chain-progress">
          ${(room.telephoneChain||[]).map((pid,i)=>{
            const p=room.players.find(pl=>pl.id===pid);
            const done=i<current, active=i===current;
            return `<div class="chain-step ${done?'done':active?'active':''}">
              ${avatarHTML(p?.name||'?',i)}
              <span class="chain-step-name">${esc(p?.name||'?')}</span>
            </div>${i<(room.telephoneChain.length-1)?'<div class="chain-arrow">→</div>':''}`;
          }).join('')}
        </div>
      </div>
      <div class="wait-center">
        <div class="wait-icon">🎙️</div>
        <h2>${esc(currentName)} is recording…</h2>
        <p>${remaining} player${remaining!==1?'s':''} still to go after them</p>
        <div class="spinner"></div>
      </div>
      ${scoreboardHTML()}
    </div>
  `);
}

// ── MODE 4: Telephone — Reveal ────────────────────────────────
async function showTelephoneReveal() {
  const room=G.room;
  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="role-banner telephone">🔊 The Audio Chain — Revealed!</div>
      ${room.telephonePrompt?`
        <div class="card card-glow-blue text-center">
          <small style="color:var(--text3)">Original Phrase</small>
          <div class="imposter-prompt" style="margin-top:8px">${esc(room.telephonePrompt)}</div>
        </div>`:''}
      <div id="tel-reveal-list" class="card" style="gap:14px;display:flex;flex-direction:column">
        <p class="text-center" style="color:var(--text3)">Loading recordings…</p>
      </div>
      ${scoreboardHTML()}
    </div>
  `);

  const list=$id('tel-reveal-list');
  if (room.telephoneRecordings?.length) {
    list.innerHTML='';
    for (let i=0;i<room.telephoneRecordings.length;i++) {
      const rec=room.telephoneRecordings[i];
      const row=document.createElement('div');
      row.className='telephone-row';
      row.innerHTML=`
        <div class="tel-row-header">
          <span class="tel-step-num">${i+1}</span>
          <span class="tel-player-name">${esc(rec.name)}</span>
          ${i===0?'<span class="tel-badge original">Original</span>':''}
        </div>
        <div class="tel-audio-wrap"></div>
      `;
      if (rec.audio&&G.audio) {
        try {
          const buf=await G.audio.fromBase64(rec.audio);
          row.querySelector('.tel-audio-wrap').appendChild(audioPlayerWidget(buf,rec.name));
        } catch(e) { row.querySelector('.tel-audio-wrap').textContent='(audio unavailable)'; }
      }
      list.appendChild(row);
    }
  }
}

// ── MODE 4: Telephone — Vote ──────────────────────────────────
function showTelephoneVote() {
  const room=G.room;
  render(`
    <div class="screen telephone-vote-screen">
      ${roundBadge()}
      <div class="role-banner telephone">🗳️ Cast Your Votes!</div>

      <div class="card card-glow-green">
        <h3>🏆 Most Accurate</h3>
        <p style="font-size:.83rem">Whose recording was closest to the original?</p>
        <div class="vote-grid" id="vg-accurate">
          ${(room.telephoneChain||[]).map((pid,i)=>{
            const p=room.players.find(pl=>pl.id===pid);
            return `<button class="vote-player-btn ${G._myTelAccuratePid===pid?'voted':''}"
              data-pid="${esc(pid)}" ${G.telephoneVotedAccurate?'disabled':''}>
              ${avatarHTML(p?.name||'?',i)}
              <span>${esc(p?.name||'?')}</span>
            </button>`;
          }).join('')}
        </div>
        ${room.telephoneVotesAccurateIn?`<p style="font-size:.8rem;color:var(--text3);margin-top:4px">${room.telephoneVotesAccurateIn} votes in</p>`:''}
      </div>

      <div class="card card-glow-pink">
        <h3>💀 Biggest Blunder</h3>
        <p style="font-size:.83rem">Whose recording was the most hilariously wrong?</p>
        <div class="vote-grid" id="vg-blunder">
          ${(room.telephoneChain||[]).map((pid,i)=>{
            const p=room.players.find(pl=>pl.id===pid);
            return `<button class="vote-player-btn ${G._myTelBlunderPid===pid?'voted':''}"
              data-pid="${esc(pid)}" ${G.telephoneVotedBlunder?'disabled':''}>
              ${avatarHTML(p?.name||'?',i)}
              <span>${esc(p?.name||'?')}</span>
            </button>`;
          }).join('')}
        </div>
        ${room.telephoneVotesBlunderIn?`<p style="font-size:.8rem;color:var(--text3);margin-top:4px">${room.telephoneVotesBlunderIn} votes in</p>`:''}
      </div>

      <div class="card">
        <div class="timer-bar-wrap"><div id="t-bar" class="timer-bar" style="width:100%"></div></div>
        <div class="timer-label" id="t-lbl">30s</div>
      </div>
      ${scoreboardHTML()}
    </div>
  `);

  if (!G.telephoneVotedAccurate) {
    document.querySelectorAll('#vg-accurate .vote-player-btn').forEach(btn=>{
      btn.onclick=()=>{
        if(G.telephoneVotedAccurate) return;
        G.telephoneVotedAccurate=true; G._myTelAccuratePid=btn.dataset.pid;
        G.socket.emit('telephone_vote_accurate',{targetPid:btn.dataset.pid});
        document.querySelectorAll('#vg-accurate .vote-player-btn').forEach(b=>{
          b.disabled=true; if(b.dataset.pid===btn.dataset.pid) b.classList.add('voted');
        });
      };
    });
  }
  if (!G.telephoneVotedBlunder) {
    document.querySelectorAll('#vg-blunder .vote-player-btn').forEach(btn=>{
      btn.onclick=()=>{
        if(G.telephoneVotedBlunder) return;
        G.telephoneVotedBlunder=true; G._myTelBlunderPid=btn.dataset.pid;
        G.socket.emit('telephone_vote_blunder',{targetPid:btn.dataset.pid});
        document.querySelectorAll('#vg-blunder .vote-player-btn').forEach(b=>{
          b.disabled=true; if(b.dataset.pid===btn.dataset.pid) b.classList.add('voted');
        });
      };
    });
  }

  const left=room.phaseEndEpoch?Math.max(0,(room.phaseEndEpoch-Date.now())/1000):30;
  startClientTimer(left,$id('t-bar'),$id('t-lbl'));
}

// ── MODE 5: Word Imposter — Reveal ───────────────────────────
function showWiReveal() {
  const room=G.room;
  const roleLabel={'civilian':'👥 You are a Civilian','imposter':'🕵️ You are the Imposter!','blank':'❓ You are Undercover (no word)'};
  const roleCls={'civilian':'wi-civilian','imposter':'wi-imposter','blank':'wi-blank'};
  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="role-banner ${roleCls[G.wiRole]||'wi-civilian'}">${roleLabel[G.wiRole]||'Waiting…'}</div>
      <div class="card card-glow-blue text-center">
        <small style="color:var(--text3)">Your secret word</small>
        ${G.wiWord
          ?`<div class="wi-word-big">${esc(G.wiWord)}</div>`
          :`<div class="wi-word-big wi-word-blank">???</div>`}
        <p style="font-size:.83rem;color:var(--text2)">Memorise it — it disappears when clue giving starts. Don't reveal it directly!</p>
      </div>
      <div class="card text-center">
        <p style="font-size:.88rem">Everyone is reading their word now…</p>
        <div class="timer-bar-wrap" style="margin-top:8px"><div id="t-bar" class="timer-bar" style="width:100%"></div></div>
        <div class="timer-label" id="t-lbl">30s</div>
      </div>
      ${scoreboardHTML()}
    </div>
  `);
  const left=room.phaseEndEpoch?Math.max(0,(room.phaseEndEpoch-Date.now())/1000):30;
  startClientTimer(left,$id('t-bar'),$id('t-lbl'));
}

// ── MODE 5: Word Imposter — Clue phase ───────────────────────
function showWiClue() {
  const room=G.room;
  const myTurnPid=room.wiClueOrder?.[room.wiCurrentClueIdx];
  const isMyTurn=myTurnPid===G.myId;
  const curPlayer=room.players.find(p=>p.id===myTurnPid);
  const total=room.wiClueOrder?.length||0;
  const done=room.wiCurrentClueIdx||0;

  const submittedClues=(room.wiClueOrder||[]).slice(0,done).map(pid=>{
    const p=room.players.find(pl=>pl.id===pid);
    const clue=room.wiClues?.[pid]||'?';
    return `<div class="wi-clue-row"><span class="wi-clue-name">${esc(p?.name||'?')}</span><span class="wi-clue-text">"${esc(clue)}"</span></div>`;
  }).join('');

  render(`
    <div class="screen wi-clue-screen">
      ${roundBadge()}
      <div class="role-banner ${G.wiRole==='imposter'?'wi-imposter':'wi-civilian'}">🗣️ Clue Phase — ${done}/${total} done</div>

      ${isMyTurn&&!G.wiClueSubmitted?`
      <div class="card card-glow-pink">
        <h3>🎤 Your turn! Give one word:</h3>
        <p style="font-size:.83rem;color:var(--text2)">One word only — hints you know the theme, without giving it away.</p>
        <input id="wi-clue-inp" type="text" class="guess-input" placeholder="Your clue word…" maxlength="30" autocomplete="off" />
        <button id="btn-wi-clue" class="btn-primary btn-full" disabled>Submit Clue 💬</button>
        <div class="timer-bar-wrap" style="margin-top:4px"><div id="t-bar" class="timer-bar" style="width:100%"></div></div>
        <div class="timer-label" id="t-lbl">30s</div>
      </div>`:`
      <div class="card text-center">
        ${G.wiClueSubmitted?`<p style="color:var(--green);font-weight:700">✅ Clue submitted! Waiting for others…</p>`
          :`<h3>🎤 ${esc(curPlayer?.name||'?')} is giving their clue…</h3>
          <div class="spinner" style="margin:8px auto"></div>`}
        <div class="timer-bar-wrap" style="margin-top:8px"><div id="t-bar" class="timer-bar" style="width:100%"></div></div>
        <div class="timer-label" id="t-lbl">30s</div>
      </div>`}

      ${submittedClues?`
      <div class="card">
        <h3>Clues so far</h3>
        <div class="wi-clues-list">${submittedClues}</div>
      </div>`:''}

      ${room.wiEliminated?.length?`
      <div class="card" style="gap:6px">
        <h3 style="font-size:.88rem;color:var(--text3)">Eliminated</h3>
        ${room.wiEliminated.map(e=>`<div class="wi-elim-row">💀 ${esc(e.name)}</div>`).join('')}
      </div>`:''}
      ${scoreboardHTML()}
    </div>
  `);

  if (isMyTurn&&!G.wiClueSubmitted) {
    const inp=$id('wi-clue-inp'), btn=$id('btn-wi-clue');
    setTimeout(()=>inp?.focus(),50);
    inp.oninput=()=>{ btn.disabled=!inp.value.trim(); };
    inp.onkeydown=e=>{ if(e.key==='Enter'&&!btn.disabled) submitWiClue(); };
    btn.onclick=submitWiClue;
  }
  const left=room.phaseEndEpoch?Math.max(0,(room.phaseEndEpoch-Date.now())/1000):30;
  startClientTimer(left,$id('t-bar'),$id('t-lbl'));
}

function submitWiClue() {
  if (G.wiClueSubmitted) return;
  const val=$id('wi-clue-inp')?.value.trim();
  if (!val) return;
  G.wiClueSubmitted=true;
  const btn=$id('btn-wi-clue'); if(btn){btn.disabled=true;btn.textContent='Submitted! ⏳';}
  G.socket.emit('wi_submit_clue',{clue:val});
}

// ── MODE 5: Word Imposter — Discuss ──────────────────────────
function showWiDiscuss() {
  const room=G.room;
  const allClues=(room.wiClueOrder||[]).map(pid=>{
    const p=room.players.find(pl=>pl.id===pid);
    const clue=room.wiClues?.[pid]||'…';
    return `<div class="wi-clue-row"><span class="wi-clue-name">${esc(p?.name||'?')}</span><span class="wi-clue-text">"${esc(clue)}"</span></div>`;
  }).join('');

  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="role-banner wi-discuss">💬 Discussion Time!</div>
      <div class="card card-glow-blue">
        <h3>All clues — Cycle ${room.wiCycleCount||1}</h3>
        <div class="wi-clues-list">${allClues||'<p style="color:var(--text3)">No clues submitted.</p>'}</div>
      </div>
      ${room.wiEliminated?.length?`
      <div class="card" style="gap:6px">
        <h3 style="font-size:.88rem;color:var(--text3)">Previously eliminated</h3>
        ${room.wiEliminated.map(e=>`<div class="wi-elim-row">💀 ${esc(e.name)}</div>`).join('')}
      </div>`:''}
      <div class="card text-center">
        <p>Talk it out — who sounds like they have a different word?</p>
        <div class="timer-bar-wrap" style="margin-top:8px"><div id="t-bar" class="timer-bar" style="width:100%"></div></div>
        <div class="timer-label" id="t-lbl">90s</div>
      </div>
      ${scoreboardHTML()}
    </div>
  `);
  const left=room.phaseEndEpoch?Math.max(0,(room.phaseEndEpoch-Date.now())/1000):90;
  startClientTimer(left,$id('t-bar'),$id('t-lbl'));
}

// ── MODE 5: Word Imposter — Vote ──────────────────────────────
function showWiVote() {
  const room=G.room;
  const alivePlayers=room.players.filter(p=>!room.wiEliminated?.some(e=>e.pid===p.id));
  render(`
    <div class="screen wi-vote-screen">
      ${roundBadge()}
      <div class="role-banner wi-imposter">🗳️ Vote to Eliminate!</div>
      <div class="card">
        <h3>Who is the imposter?</h3>
        <p style="font-size:.83rem;color:var(--text3)">Votes in: <strong style="color:var(--text)">${room.wiVotesIn||0} / ${alivePlayers.length}</strong></p>
        <div class="imposter-vote-grid">
          ${alivePlayers.filter(p=>p.id!==G.myId).map((p,i)=>`
            <button class="vote-player-btn ${G.wiMyVotePid===p.id?'voted':''}"
              data-pid="${esc(p.id)}" ${G.wiVoted?'disabled':''}>
              ${avatarHTML(p.name,i)}
              <span>${esc(p.name)}</span>
            </button>`).join('')}
        </div>
        ${G.wiVoted?`<p class="text-center" style="color:var(--green);font-weight:700;margin-top:8px">✅ Vote cast! Waiting for others…</p>`:''}
      </div>
      <div class="card">
        <div class="timer-bar-wrap"><div id="t-bar" class="timer-bar" style="width:100%"></div></div>
        <div class="timer-label" id="t-lbl">35s</div>
      </div>
      ${scoreboardHTML()}
    </div>
  `);
  if (!G.wiVoted) {
    document.querySelectorAll('.vote-player-btn').forEach(btn=>{
      btn.onclick=()=>{
        if(G.wiVoted) return;
        G.wiVoted=true; G.wiMyVotePid=btn.dataset.pid;
        G.socket.emit('wi_vote',{targetPid:btn.dataset.pid});
        document.querySelectorAll('.vote-player-btn').forEach(b=>{
          b.disabled=true;
          if(b.dataset.pid===btn.dataset.pid) b.classList.add('voted');
        });
      };
    });
  }
  const left=room.phaseEndEpoch?Math.max(0,(room.phaseEndEpoch-Date.now())/1000):35;
  startClientTimer(left,$id('t-bar'),$id('t-lbl'));
}

// ── MODE 5: Word Imposter — Imposter Guess ────────────────────
function showWiGuess() {
  const room=G.room;
  const amImposter=G.wiRole==='imposter';
  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="role-banner wi-imposter">🎯 ${amImposter?'Last Chance — Guess the Civilian Word!':'Imposter is guessing…'}</div>
      ${amImposter?`
      <div class="card card-glow-pink">
        <h3>You survived! Can you guess what the civilians' word was?</h3>
        <p>Get it right for <strong style="color:var(--gold)">+75 bonus points!</strong></p>
        <input id="wi-guess-inp" type="text" class="guess-input" placeholder="Civilian word…" maxlength="40" autocomplete="off" />
        <button id="btn-wi-guess" class="btn-primary btn-full" disabled>Submit Guess 🎯</button>
        <div class="timer-bar-wrap" style="margin-top:4px"><div id="t-bar" class="timer-bar" style="width:100%"></div></div>
        <div class="timer-label" id="t-lbl">20s</div>
      </div>`:`
      <div class="card text-center">
        <h3>⏳ The imposter is making their final guess…</h3>
        <div class="spinner" style="margin:8px auto"></div>
        <div class="timer-bar-wrap" style="margin-top:8px"><div id="t-bar" class="timer-bar" style="width:100%"></div></div>
        <div class="timer-label" id="t-lbl">20s</div>
      </div>`}
      ${scoreboardHTML()}
    </div>
  `);
  if (amImposter&&!G.wiGuessSubmitted) {
    const inp=$id('wi-guess-inp'), btn=$id('btn-wi-guess');
    setTimeout(()=>inp?.focus(),50);
    inp.oninput=()=>{ btn.disabled=!inp.value.trim(); };
    inp.onkeydown=e=>{ if(e.key==='Enter'&&!btn.disabled) submitWiGuess(); };
    btn.onclick=submitWiGuess;
  }
  const left=room.phaseEndEpoch?Math.max(0,(room.phaseEndEpoch-Date.now())/1000):20;
  startClientTimer(left,$id('t-bar'),$id('t-lbl'));
}

function submitWiGuess() {
  if (G.wiGuessSubmitted) return;
  const val=$id('wi-guess-inp')?.value.trim();
  if (!val) return;
  G.wiGuessSubmitted=true;
  const btn=$id('btn-wi-guess'); if(btn){btn.disabled=true;btn.textContent='Submitted! ⏳';}
  G.socket.emit('wi_imposter_guess',{guess:val});
}

// ── Generic waiting ───────────────────────────────────────────
function showWaiting(msg,sub) {
  const amHost=G.room?.hostId===G.myId;
  render(`
    <div class="screen">
      ${roundBadge()}
      <div class="wait-center">
        <div class="wait-icon">✨</div>
        <h2>${esc(msg)}</h2>
        ${sub?`<p>${esc(sub)}</p>`:''}
        <div class="spinner"></div>
      </div>
      ${scoreboardHTML()}
      ${amHost?`<button id="btn-force-lobby" class="btn-ghost btn-full" style="margin-top:8px;font-size:.82rem;color:var(--text3)">↩ Abort &amp; Return to Lobby</button>`:''}
    </div>
  `);
  if (amHost) {
    const b=$id('btn-force-lobby');
    if(b) b.onclick=()=>{ if(confirm('Abort and return everyone to lobby?')) G.socket.emit('force_lobby'); };
  }
}

// ── Round result ──────────────────────────────────────────────
async function showRoundResult() {
  const room=G.room, result=room.roundResult;
  if (!result) return;
  const amHost=room.hostId===G.myId;

  if (room.mode==='reverse') {
    const {celebrity,speakerName,stumped,guesses}=result;
    render(`
      <div class="screen">
        ${roundBadge()}
        <div class="card ${stumped?'card-glow-pink':'card-glow-green'} text-center">
          <div style="font-size:2.5rem">${stumped?'😈':'🎉'}</div>
          <h2>${stumped?`${esc(speakerName)} stumped everyone!`:'Correct guesses!'}</h2>
          <p>The celebrity was:</p>
          <div class="celeb-big">${esc(celebrity)}</div>
        </div>
        <div class="card">
          <h3>Guesses</h3>
          ${guesses.length?guesses.map(g=>`
            <div class="guess-result-row ${g.correct?'correct':'wrong'}">
              <span class="gr-name">${esc(g.name)}</span>
              <span class="gr-guess">${esc(g.guess)}</span>
              <span class="gr-pts">${g.points>0?'+'+g.points:'—'}</span>
            </div>`).join(''):'<p style="color:var(--text3)">Nobody guessed in time.</p>'}
          ${stumped?`<div class="guess-result-row correct"><span class="gr-name">🎙️ ${esc(speakerName)}</span><span class="gr-guess">Stumped the room!</span><span class="gr-pts">+80</span></div>`:''}
        </div>
        ${scoreboardHTML()}
        ${amHost?`<button id="btn-next" class="btn-primary btn-full">Next Round ➡️</button>`:'<p class="text-center" style="color:var(--text3)">Waiting for host…</p>'}
      </div>
    `);

  } else if (room.mode==='noise') {
    const {creatorName,ranking}=result;
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
        ${amHost?`<button id="btn-next" class="btn-primary btn-full">Next Round ➡️</button>`:'<p class="text-center" style="color:var(--text3)">Waiting for host…</p>'}
      </div>
    `);
    const list=$id('mimic-result-list');
    const ICONS=['🥇','🥈','🥉'];
    for (const r of ranking) {
      const row=document.createElement('div');
      row.className='mimic-row';
      row.innerHTML=`
        <div class="mimic-header">
          <span class="mimic-rank">${ICONS[r.rank-1]||`#${r.rank}`}</span>
          <span class="mimic-name">${esc(r.name)}</span>
          <span class="mimic-pct" style="color:${r.score>=75?'var(--green)':r.score>=50?'var(--orange)':'var(--red)'}">${r.score}%</span>
          <span class="mimic-pts">+${r.points} pts</span>
        </div>
        <div class="mimic-comment">${esc(r.commentary)}</div>
      `;
      if (room.roundResult?.mimics?.[r.playerId]?.audio) {
        try {
          const buf=await G.audio.fromBase64(room.roundResult.mimics[r.playerId].audio);
          row.appendChild(audioPlayerWidget(buf,`${r.name}'s mimic`));
        } catch(e) {}
      }
      list.appendChild(row);
    }

  } else if (room.mode==='imposter') {
    const {imposterName,imposterCaught,prompt,effect,voteList}=result;
    render(`
      <div class="screen">
        ${roundBadge()}
        <div class="card ${imposterCaught?'card-glow-green':'card-glow-pink'} text-center">
          <div style="font-size:2.5rem">${imposterCaught?'🎉':'🕵️'}</div>
          <h2>${imposterCaught?'Imposter was caught!':'Imposter escaped!'}</h2>
          <p>The imposter was <strong>${esc(imposterName)}</strong></p>
          <div class="effect-badge" style="margin:8px auto">${effectLabel(effect)}</div>
          <p style="font-size:.82rem;color:var(--text2)">"${esc(prompt)}"</p>
        </div>
        <div class="card">
          <h3>Votes</h3>
          ${(voteList||[]).map(v=>`
            <div class="guess-result-row ${v.targetId===result.imposterId?'correct':'wrong'}">
              <span class="gr-name">${esc(v.voterName)}</span>
              <span class="gr-guess">voted → ${esc(v.targetName)}</span>
              <span class="gr-pts">${v.targetId===result.imposterId?'+75':'—'}</span>
            </div>`).join('')}
          ${imposterCaught
            ?`<div class="guess-result-row wrong"><span class="gr-name">🕵️ ${esc(imposterName)}</span><span class="gr-guess">Was caught</span><span class="gr-pts">+0</span></div>`
            :`<div class="guess-result-row correct"><span class="gr-name">🕵️ ${esc(imposterName)}</span><span class="gr-guess">Escaped undetected!</span><span class="gr-pts">+100</span></div>`}
        </div>
        ${scoreboardHTML()}
        ${amHost?`<button id="btn-next" class="btn-primary btn-full">Next Round ➡️</button>`:'<p class="text-center" style="color:var(--text3)">Waiting for host…</p>'}
      </div>
    `);

  } else if (room.mode==='word_imposter') {
    const {winner,civilianWord,imposterWord,assignments,eliminated,imposterGuessedCorrectly}=result;
    render(`
      <div class="screen">
        ${roundBadge()}
        <div class="card ${winner==='civilian'?'card-glow-green':'card-glow-pink'} text-center">
          <div style="font-size:2.5rem">${winner==='civilian'?'🎉':'🕵️'}</div>
          <h2>${winner==='civilian'?'Civilians win!':'Imposter survives!'}</h2>
          <p>Civilian word: <strong>${esc(civilianWord)}</strong></p>
          <p>Imposter word: <strong>${esc(imposterWord)}</strong></p>
          ${imposterGuessedCorrectly?`<p style="color:var(--gold);font-weight:700;margin-top:4px">🎯 Imposter guessed correctly! +75 pts</p>`:''}
        </div>
        <div class="card" style="gap:8px">
          <h3>Roles revealed</h3>
          ${(assignments||[]).map(a=>`
            <div class="guess-result-row ${a.role==='imposter'?'wrong':'correct'}">
              <span class="gr-name">${esc(a.name)}</span>
              <span class="gr-guess">${a.role==='imposter'?'🕵️ Imposter':a.role==='blank'?'❓ Undercover':'👥 Civilian'}${a.word?' — "'+esc(a.word)+'"':''}</span>
              <span class="gr-pts"></span>
            </div>`).join('')}
        </div>
        ${scoreboardHTML()}
        ${amHost?`<button id="btn-next" class="btn-primary btn-full">Next Round ➡️</button>`:'<p class="text-center" style="color:var(--text3)">Waiting for host…</p>'}
      </div>
    `);

  } else if (room.mode==='telephone') {
    const {originalPhrase,mostAccName,blunderName}=result;
    render(`
      <div class="screen">
        ${roundBadge()}
        <div class="card text-center card-glow-blue">
          <div style="font-size:2rem">📞</div>
          <h2>Broken Telephone Results</h2>
          <small style="color:var(--text3)">Original phrase:</small>
          <div class="imposter-prompt" style="margin-top:8px">${esc(originalPhrase)}</div>
        </div>
        <div class="card" style="gap:10px">
          ${mostAccName?`
          <div class="guess-result-row correct">
            <span class="gr-name">🏆 Most Accurate</span>
            <span class="gr-guess">${esc(mostAccName)}</span>
            <span class="gr-pts">+50</span>
          </div>`:''}
          ${blunderName?`
          <div class="guess-result-row">
            <span class="gr-name">💀 Biggest Blunder</span>
            <span class="gr-guess">${esc(blunderName)}</span>
            <span class="gr-pts">+25</span>
          </div>`:''}
        </div>
        ${scoreboardHTML()}
        ${amHost?`<button id="btn-next" class="btn-primary btn-full">Next Round ➡️</button>`:'<p class="text-center" style="color:var(--text3)">Waiting for host…</p>'}
      </div>
    `);
  }

  if (amHost) { const nb=$id('btn-next'); if(nb) nb.onclick=()=>G.socket.emit('next_round'); }
}

// ── Scoring / analyzing ───────────────────────────────────────
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

// ── Final podium ──────────────────────────────────────────────
function showPodium() {
  const {podium,allScores}=G.room.roundResult;
  launchConfetti();
  const [first,second,third]=podium;
  render(`
    <div class="screen">
      <h1 class="text-center gradient-text">Game Over! 🏆</h1>
      <div class="podium">
        ${second?`<div class="podium-place"><div class="podium-trophy">🥈</div><div class="podium-name">${esc(second.name)}</div><div class="podium-score">${second.score}</div><div class="podium-block silver"></div></div>`:'<div class="podium-place"></div>'}
        ${first ?`<div class="podium-place"><div class="podium-trophy">🥇</div><div class="podium-name">${esc(first.name)}</div><div class="podium-score">${first.score}</div><div class="podium-block gold"></div></div>`:''}
        ${third ?`<div class="podium-place"><div class="podium-trophy">🥉</div><div class="podium-name">${esc(third.name)}</div><div class="podium-score">${third.score}</div><div class="podium-block bronze"></div></div>`:'<div class="podium-place"></div>'}
      </div>
      <div class="card">
        <h3>Full Leaderboard</h3>
        <div class="player-list">
          ${allScores.map((p,i)=>`
            <div class="player-row ${p.id===G.myId?'me':''}">
              <span style="font-weight:900;font-size:1.1rem;min-width:28px">${i+1}</span>
              <span class="player-name">${esc(p.name)}</span>
              <span class="player-score">${p.score}</span>
            </div>`).join('')}
        </div>
      </div>
      ${G.room.hostId===G.myId?`
      <div class="flex-row">
        <button id="btn-rematch" class="btn-primary">🔁 Rematch</button>
        <button id="btn-lobby"   class="btn-ghost">🏠 Lobby</button>
      </div>`:'<p class="text-center" style="color:var(--text3)">Waiting for host…</p>'}
    </div>
  `);
  if (G.room.hostId===G.myId) {
    $id('btn-rematch').onclick = () => G.socket.emit('play_again');
    $id('btn-lobby').onclick   = () => G.socket.emit('back_to_lobby');
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN RENDER ROUTER
// ═══════════════════════════════════════════════════════════════
function renderPhase() {
  const room=G.room;
  if (!room) return showLanding();

  switch (room.phase) {
    case 'lobby':          return showLobby();
    case 'speaker_cat':    return G.isSpeaker ? showSpeakerCatSelect() : showWaiting('Speaker is choosing a category…','Get ready to guess!');
    case 'speaker_celeb':  return G.isSpeaker ? showSpeakerCelebSelect(G.celebOptions) : showWaiting('Speaker is choosing a celebrity…','');
    case 'speaker_record': return G.isSpeaker ? showSpeakerRecord(room._celeb||'') : showWaiting('Speaker is recording…','You\'ll hear reversed audio soon!');
    case 'guessing':
      if (G.isSpeaker) return showSpeakerWaiting();
      if (G.speakerBuf) {
        if ($app().querySelector('.role-banner.guesser')) return;
        return showGuesserTurn(G.speakerBuf);
      }
      return showWaiting('Loading reversed audio…','');
    case 'noise_record':   return G.isCreator ? showNoiseCreatorRecord() : showWaiting('Noise creator is recording a sound…','Listen carefully — you\'ll need to mimic it!');
    case 'noise_mimic':
      if (G.isCreator) return showCreatorWaiting();
      if (G.creatorBuf) {
        if ($app().querySelector('.role-banner.mimic') && !G.mimicSubmitted) return;
        return showNoiseMimicTurn(G.creatorBuf);
      }
      return showWaiting('Loading target sound…','');
    case 'noise_scoring':  return showScoring();
    case 'imposter_record':return G.isImposter ? showImposterRecord(G._imposterPrompt||'…',G.imposterEffect||'robot') : showImposterWaiting();
    case 'imposter_vote': {
      if (G.imposterAudioBuf) {
        if ($app().querySelector('.imposter-vote-screen') && !G.imposterVoted) return;
        return showImposterVote();
      }
      return showWaiting('Loading disguised voice…','');
    }
    case 'telephone_chain': {
      const myIdx=room.telephoneChain?.indexOf(G.myId)??-1;
      if (myIdx===room.telephoneCurrentIdx) {
        if ($app().querySelector('.telephone-my-turn-screen') && !G.myTelephoneSubmitted) return;
        if (myIdx===0 && G._telephonePrompt) return showTelephoneMyTurn(myIdx,room.telephoneChain.length,G._telephonePrompt,null);
        if (myIdx>0  && G.telephoneListenBuf) return showTelephoneMyTurn(myIdx,room.telephoneChain.length,null,G.telephoneListenBuf);
        return showWaiting('Preparing your turn…','');
      }
      const curPlayer=room.players.find(p=>p.id===room.telephoneChain?.[room.telephoneCurrentIdx]);
      const remaining=(room.telephoneChain?.length||0)-room.telephoneCurrentIdx-1;
      return showTelephoneWaiting(curPlayer?.name||'?',remaining);
    }
    case 'telephone_reveal': return showTelephoneReveal();
    case 'telephone_vote': {
      if ($app().querySelector('.telephone-vote-screen') && !(G.telephoneVotedAccurate&&G.telephoneVotedBlunder)) return;
      return showTelephoneVote();
    }
    case 'wi_reveal':  return showWiReveal();
    case 'wi_clue': {
      const isMyTurn=room.wiClueOrder?.[room.wiCurrentClueIdx]===G.myId;
      if (isMyTurn&&!G.wiClueSubmitted&&$app().querySelector('.wi-clue-screen')) return;
      return showWiClue();
    }
    case 'wi_discuss': return showWiDiscuss();
    case 'wi_vote': {
      if ($app().querySelector('.wi-vote-screen')&&!G.wiVoted) return;
      return showWiVote();
    }
    case 'wi_guess':   return showWiGuess();
    case 'round_result':   return showRoundResult();
    case 'final':          return showPodium();
    default:               return showWaiting('Loading…','');
  }
}

// ═══════════════════════════════════════════════════════════════
// SOCKET SETUP
// ═══════════════════════════════════════════════════════════════
function initSocket(onReady) {
  const s=io({ transports:['websocket','polling'] });
  G.socket=s;

  s.on('connect', () => {
    removeDisconnectOverlay();
    if (SESSION.id && SESSION.room) s.emit('rejoin',{playerId:SESSION.id,roomCode:SESSION.room});
    if (onReady) { onReady(); onReady=null; }
  });

  s.on('disconnect', () => { stopClientTimer(); showDisconnectOverlay(); });
  s.on('reconnect',  () => { removeDisconnectOverlay(); toast('Reconnected!','success'); });

  // ── Room events ──────────────────────────────────────────────
  s.on('room_created', ({playerId,room}) => {
    G.myId=playerId; G.myName=room.players.find(p=>p.id===playerId)?.name||''; G.room=room;
    G.isSpeaker=false; G.isCreator=false; G.isImposter=false;
    SESSION.save(playerId,G.myName,room.code); renderPhase();
  });

  s.on('room_joined', ({playerId,room}) => {
    G.myId=playerId; G.myName=room.players.find(p=>p.id===playerId)?.name||''; G.room=room;
    SESSION.save(playerId,G.myName,room.code); renderPhase();
  });

  s.on('rejoin_success', ({playerId,room}) => {
    G.myId=playerId; G.room=room;
    G.myName=room.players.find(p=>p.id===playerId)?.name||SESSION.name||'';
    const spId=room.speakerOrder?.[room.speakerIdx];
    G.isSpeaker  = (spId===playerId) && ['speaker_cat','speaker_celeb','speaker_record','guessing'].includes(room.phase);
    G.isCreator  = (spId===playerId) && ['noise_record','noise_mimic'].includes(room.phase);
    G.isImposter = (spId===playerId) && ['imposter_record','imposter_vote'].includes(room.phase);
    if (room.hostId===playerId && room.phase==='lobby') {
      const stay=confirm('You refreshed as the room host.\n\nStay as host → OK\nLeave room → Cancel');
      if (!stay) { G.socket.emit('leave_room'); SESSION.clear(); G.room=null; showLanding(); return; }
    }
    toast('Rejoined! ✅','success'); renderPhase();
  });

  s.on('rejoin_failed', ({msg}) => { SESSION.clear(); toast(msg||'Session expired','error'); showLanding(); });

  s.on('room_snapshot', async room => {
    G.room=room;

    // Clear state at round boundary
    if (room.currentRound !== G._lastRound) {
      G._lastRound=room.currentRound;
      G.speakerBuf=null; G.creatorBuf=null;
      G.imposterAudioBuf=null; G.telephoneListenBuf=null;
      G._imposterPrompt=null; G._telephonePrompt=null;
      G.isImposter=false; G.imposterVoted=false; G._myImposterVote=null;
      G.telephoneVotedAccurate=false; G.telephoneVotedBlunder=false;
      G._myTelAccuratePid=null; G._myTelBlunderPid=null;
      G.myTelephoneSubmitted=false; G.guessSubmitted=false; G.mimicSubmitted=false;
      G.nameHint=null;
      G.wiRole=null; G.wiWord=null; G.wiClueSubmitted=false;
      G.wiVoted=false; G.wiMyVotePid=null; G.wiGuessSubmitted=false;
      G._wiLastPhase=null;
    }

    // WI phase transition resets (between cycles)
    if (G._wiLastPhase!==room.phase) {
      if (room.phase==='wi_clue') G.wiClueSubmitted=false;
      if (room.phase==='wi_vote') { G.wiVoted=false; G.wiMyVotePid=null; }
      G._wiLastPhase=room.phase;
    }

    // Recompute roles from speakerOrder
    const spId=room.speakerOrder?.[room.speakerIdx];
    if (['speaker_cat','speaker_celeb','speaker_record','guessing'].includes(room.phase)) {
      G.isSpeaker=(spId===G.myId); G.isCreator=false; G.isImposter=false;
    } else if (['noise_record','noise_mimic'].includes(room.phase)) {
      G.isCreator=(spId===G.myId); G.isSpeaker=false; G.isImposter=false;
    } else if (['imposter_record','imposter_vote'].includes(room.phase)) {
      G.isImposter=(spId===G.myId); G.isSpeaker=false; G.isCreator=false;
    } else {
      G.isSpeaker=false; G.isCreator=false; G.isImposter=false;
    }

    // Decode audio from snapshot as reliable fallback
    if (room.phase==='noise_mimic' && !G.isCreator && room.creatorAudio && !G.creatorBuf && G.audio)
      try { G.creatorBuf=await G.audio.fromBase64(room.creatorAudio); } catch(e) {}
    if (room.phase==='guessing' && !G.isSpeaker && room.speakerAudio && !G.speakerBuf && G.audio)
      try { G.speakerBuf=await G.audio.fromBase64(room.speakerAudio); } catch(e) {}
    if (room.phase==='imposter_vote' && room.imposterAudio && !G.imposterAudioBuf && G.audio)
      try { G.imposterAudioBuf=await G.audio.fromBase64(room.imposterAudio); } catch(e) {}

    renderPhase();
  });

  s.on('join_error',  ({msg}) => toast(msg,'error'));
  s.on('error_msg',   ({msg}) => toast(msg,'error'));

  // ── Private role notifications ───────────────────────────────
  s.on('you_are_speaker', () => {
    G.isSpeaker=true; G.isCreator=false; G.isImposter=false;
    if (G.room?.phase==='speaker_cat') showSpeakerCatSelect();
  });

  s.on('you_are_creator', () => {
    G.isCreator=true; G.isSpeaker=false; G.isImposter=false;
    if (G.room?.phase==='noise_record') showNoiseCreatorRecord();
  });

  s.on('you_are_imposter', ({prompt,effect}) => {
    G.isImposter=true; G.isSpeaker=false; G.isCreator=false;
    G._imposterPrompt=prompt; G.imposterEffect=effect;
    if (G.room?.phase==='imposter_record') showImposterRecord(prompt,effect);
  });

  s.on('celeb_options',   ({options}) => { G.celebOptions=options; if(G.room?.phase==='speaker_celeb') showSpeakerCelebSelect(options); });
  s.on('celeb_confirmed', ({celeb})   => { G.room._celeb=celeb;    if(G.room?.phase==='speaker_record') showSpeakerRecord(celeb); });

  // ── Audio delivery ───────────────────────────────────────────
  s.on('reversed_audio', async ({audioBase64}) => {
    if (G.isSpeaker) return;
    try {
      toast('Reversed audio incoming… 🔀','info');
      G.speakerBuf=await G.audio.fromBase64(audioBase64);
      showGuesserTurn(G.speakerBuf);
    } catch(e) { console.error('reversed_audio decode:',e); toast('Failed to load reversed audio','error'); }
  });

  s.on('creator_audio', async ({audioBase64}) => {
    if (G.isCreator) return;
    try {
      toast('Target sound received — loading…','info');
      G.creatorBuf=await G.audio.fromBase64(audioBase64);
      showNoiseMimicTurn(G.creatorBuf);
    } catch(e) { console.error('creator_audio decode:',e); toast('Failed to load sound','error'); }
  });

  s.on('imposter_audio_relay', async ({audioBase64,effect}) => {
    G.imposterEffect=effect;
    try {
      G.imposterAudioBuf=await G.audio.fromBase64(audioBase64);
      if (G.room?.phase==='imposter_vote') showImposterVote();
    } catch(e) { console.error('imposter_audio_relay decode:',e); }
  });

  // ── Telephone chain ──────────────────────────────────────────
  s.on('telephone_prompt', ({prompt,chainIdx,chainLength}) => {
    G._telephonePrompt=prompt; G.telephoneChainIdx=chainIdx; G.telephoneListenBuf=null;
    if (G.room?.phase==='telephone_chain') showTelephoneMyTurn(chainIdx,chainLength,prompt,null);
  });

  s.on('telephone_listen', async ({audioBase64,chainIdx,chainLength}) => {
    G.telephoneChainIdx=chainIdx; G._telephonePrompt=null;
    try {
      G.telephoneListenBuf=await G.audio.fromBase64(audioBase64);
      if (G.room?.phase==='telephone_chain') showTelephoneMyTurn(chainIdx,chainLength,null,G.telephoneListenBuf);
    } catch(e) { console.error('telephone_listen decode:',e); }
  });

  // ── Mode 5 — Word Imposter ───────────────────────────────────
  s.on('wi_role', ({role,word}) => {
    G.wiRole=role; G.wiWord=word;
    if (G.room?.phase==='wi_reveal') showWiReveal();
  });

  s.on('wi_your_turn', () => {
    if (G.room?.phase==='wi_clue') showWiClue();
  });

  s.on('wi_guess_prompt', () => {
    if (G.room?.phase==='wi_guess') showWiGuess();
  });

  // ── Name hint ────────────────────────────────────────────────
  s.on('name_hint', ({hint}) => {
    G.nameHint=hint;
    const el=$id('name-hint-reveal');
    if (el) { el.textContent=hint; el.style.display=''; }
  });

  // ── Live feeds ───────────────────────────────────────────────
  s.on('guess_in', ({name,correct,firstCorrect,points}) => {
    const msg=correct
      ?`✅ <strong>${esc(name)}</strong> got it! ${firstCorrect?'+100':'+'+(points||60)} pts`
      :`❌ <strong>${esc(name)}</strong> guessed wrong`;
    addFeedItem(msg,correct?'correct':'wrong');
    if (correct) toast(`${name} got it!`,'success');
  });

  s.on('mimic_in', async ({name,audioBase64}) => {
    const feed=$id('mimic-feed');
    if (feed) {
      const d=document.createElement('div');
      d.className='feed-item info';
      d.style.flexDirection='column'; d.style.alignItems='flex-start'; d.style.gap='6px';
      d.innerHTML=`<span>${esc(name)} submitted their mimic ✓</span>`;
      if (audioBase64&&G.audio) {
        try { const buf=await G.audio.fromBase64(audioBase64); d.appendChild(audioPlayerWidget(buf,`${name}'s mimic`)); }
        catch(e) {}
      }
      feed.appendChild(d);
    }
  });

  // ── Kick / Leave ─────────────────────────────────────────────
  s.on('kicked', ({msg}) => {
    SESSION.clear(); G.room=null;
    toast(msg||'You were kicked from the room.','error');
    showLanding();
  });

  // ── Player connection events ─────────────────────────────────
  s.on('player_reconnected',  ({name}) => toast(`${name} reconnected ✅`,'info'));
  s.on('player_disconnected', ({name}) => toast(`${name} disconnected 📵`,'error'));

  // iOS Safari visibility fix
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState==='visible' && !s.connected) s.connect();
  });
}

// ── Disconnect overlay ────────────────────────────────────────
function showDisconnectOverlay() {
  if ($id('dc-overlay')) return;
  const el=document.createElement('div');
  el.id='dc-overlay';
  el.innerHTML=`
    <div class="dc-card">
      <div style="font-size:2rem">📵</div>
      <h3>Connection lost</h3>
      <p>Your spot is saved for 5 minutes. Reconnecting…</p>
      <div class="spinner" style="margin:0 auto"></div>
    </div>`;
  document.body.appendChild(el);
}

function removeDisconnectOverlay() { $id('dc-overlay')?.remove(); }

// ═══════════════════════════════════════════════════════════════
// ENTRY POINTS
// ═══════════════════════════════════════════════════════════════
async function doCreate(name) {
  if (!name) { toast('Enter your name!','error'); return; }
  await ensureAudio();
  if (!G.socket) initSocket();
  G.myName=name; G.isSpeaker=false; G.isCreator=false; G.isImposter=false;
  G.socket.emit('create_room',{playerName:name});
}

async function doJoin(name,code) {
  if (!name) { toast('Enter your name!','error'); return; }
  if (!code||code.length<4) { toast('Enter a valid room code!','error'); return; }
  await ensureAudio();
  if (!G.socket) initSocket();
  G.myName=name; G.isSpeaker=false; G.isCreator=false; G.isImposter=false;
  G.socket.emit('join_room',{roomCode:code,playerName:name});
}

async function ensureAudio() {
  if (G.audio) return;
  try {
    G.audio=new AudioManager();
    await G.audio.init();
    const unlock=()=>{ if(G.audio?.ctx?.state==='suspended') G.audio.ctx.resume().catch(()=>{}); };
    document.addEventListener('touchstart',unlock,{passive:true});
    document.addEventListener('click',     unlock,{passive:true});
  } catch(e) {
    toast('Microphone access required! Please allow it and try again.','error');
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  const urlRoom=new URLSearchParams(location.search).get('room');

  // If opened via invite link, show the dedicated join screen
  if (urlRoom && !SESSION.id) {
    ensureAudio().then(() => {
      initSocket(() => {});
      showInviteJoin(urlRoom.toUpperCase());
    }).catch(() => showInviteJoin(urlRoom.toUpperCase()));
    return;
  }

  // Auto-rejoin if session stored
  if (SESSION.id && SESSION.room) {
    ensureAudio().then(() => {
      initSocket(() => {});
    }).catch(() => showLanding());
  } else {
    showLanding();
  }
});
