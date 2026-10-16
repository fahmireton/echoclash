'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// MFCC + DTW Audio Similarity Engine
//
// Pipeline:
//   WAV → frames → Hamming window → FFT → power spectrum
//   → mel filterbank → log energy → DCT → MFCC coefficients
//   → cepstral mean normalisation → DTW distance → 0-100 score
//
// MFCCs capture the *timbral character* of a sound — what makes a clap sound
// like a clap regardless of exact timing or volume.  DTW aligns the two
// sequences in time before comparing, so a slightly slower mimic still scores
// well.  This is the same approach used in speech / sound recognition systems.
// ══════════════════════════════════════════════════════════════════════════════

// ── Constants ─────────────────────────────────────────────────────────────────
const FRAME_SIZE  = 1024;   // ~23 ms at 44 100 Hz
const HOP_SIZE    = 512;    // 50 % overlap
const NUM_FILTERS = 26;     // mel triangular filters
const NUM_COEFFS  = 13;     // MFCC coefficients kept (0-12)

// ── Pre-built tables (cached once per sample rate) ───────────────────────────
const _melFilterCache = new Map();
const _hammingWin     = buildHamming(FRAME_SIZE);

// ── WAV Parser ────────────────────────────────────────────────────────────────
function parseWAV(base64) {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length < 44) throw new Error('WAV too small');

  const numChannels  = buf.readUInt16LE(22);
  const sampleRate   = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);

  let dataStart = 44, dataSize = buf.length - 44, offset = 12;
  while (offset < buf.length - 8) {
    const id   = buf.slice(offset, offset + 4).toString('ascii');
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'data') { dataStart = offset + 8; dataSize = size; break; }
    offset += 8 + (size % 2 ? size + 1 : size);
  }

  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor(dataSize / (bytesPerSample * numChannels));
  const samples = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    let sum = 0;
    for (let c = 0; c < numChannels; c++) {
      const o = dataStart + (i * numChannels + c) * bytesPerSample;
      if (o + 2 > buf.length) break;
      sum += buf.readInt16LE(o) / 32768.0;
    }
    samples[i] = sum / numChannels;
  }
  return { samples, sampleRate, duration: numSamples / sampleRate };
}

// ── FFT (Cooley-Tukey radix-2 in-place) ──────────────────────────────────────
function fftInPlace(re, im) {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  // Butterfly stages
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wR = Math.cos(ang), wI = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cR = 1, cI = 0;
      for (let k = 0; k < half; k++) {
        const uR = re[i+k], uI = im[i+k];
        const vR = re[i+k+half]*cR - im[i+k+half]*cI;
        const vI = re[i+k+half]*cI + im[i+k+half]*cR;
        re[i+k]       = uR + vR;  im[i+k]       = uI + vI;
        re[i+k+half]  = uR - vR;  im[i+k+half]  = uI - vI;
        const nR = cR*wR - cI*wI;
        cI = cR*wI + cI*wR;
        cR = nR;
      }
    }
  }
}

// ── Windowing ─────────────────────────────────────────────────────────────────
function buildHamming(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (n - 1));
  return w;
}

// ── Mel filterbank ────────────────────────────────────────────────────────────
function hzToMel(hz)  { return 2595 * Math.log10(1 + hz / 700); }
function melToHz(mel) { return 700 * (Math.pow(10, mel / 2595) - 1); }

function buildMelFilters(sampleRate) {
  const fMin = 80, fMax = Math.min(8000, sampleRate / 2);
  const melMin = hzToMel(fMin), melMax = hzToMel(fMax);
  const halfN  = FRAME_SIZE >> 1;

  // Evenly-spaced points on the mel scale, converted to FFT bin indices
  const bins = Array.from({ length: NUM_FILTERS + 2 }, (_, i) => {
    const mel = melMin + i * (melMax - melMin) / (NUM_FILTERS + 1);
    return Math.floor((FRAME_SIZE + 1) * melToHz(mel) / sampleRate);
  });

  return Array.from({ length: NUM_FILTERS }, (_, m) => {
    const filter = new Float32Array(halfN);
    for (let k = Math.max(0, bins[m]); k < Math.min(halfN, bins[m+2]); k++) {
      filter[k] = k < bins[m+1]
        ? (k - bins[m])   / (bins[m+1] - bins[m]   + 1e-10)
        : (bins[m+2] - k) / (bins[m+2] - bins[m+1] + 1e-10);
    }
    return filter;
  });
}

function getMelFilters(sampleRate) {
  if (!_melFilterCache.has(sampleRate))
    _melFilterCache.set(sampleRate, buildMelFilters(sampleRate));
  return _melFilterCache.get(sampleRate);
}

// ── DCT-II ────────────────────────────────────────────────────────────────────
function dct2(x) {
  const n = x.length;
  const out = new Float32Array(NUM_COEFFS);
  for (let k = 0; k < NUM_COEFFS; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += x[i] * Math.cos(Math.PI * k * (2*i+1) / (2*n));
    out[k] = s;
  }
  return out;
}

// ── MFCC extraction ───────────────────────────────────────────────────────────
function extractMFCC(samples, sampleRate) {
  const filters = getMelFilters(sampleRate);
  const halfN   = FRAME_SIZE >> 1;
  const frames  = [];

  // Pre-emphasis (high-pass, boosts high-frequency detail)
  const sig = new Float32Array(samples.length);
  sig[0] = samples[0];
  for (let i = 1; i < samples.length; i++) sig[i] = samples[i] - 0.97 * samples[i-1];

  for (let start = 0; start + FRAME_SIZE <= sig.length; start += HOP_SIZE) {
    const re = new Float32Array(FRAME_SIZE);
    const im = new Float32Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) re[i] = sig[start+i] * _hammingWin[i];

    fftInPlace(re, im);

    // Power spectrum (positive frequencies)
    const power = new Float32Array(halfN);
    for (let i = 0; i < halfN; i++) power[i] = (re[i]*re[i] + im[i]*im[i]) / FRAME_SIZE;

    // Mel filterbank → log energies
    const melE = new Float32Array(NUM_FILTERS);
    for (let m = 0; m < NUM_FILTERS; m++) {
      let e = 0;
      for (let k = 0; k < halfN; k++) e += power[k] * filters[m][k];
      melE[m] = Math.log(Math.max(e, 1e-10));
    }

    frames.push(dct2(melE));
  }

  if (!frames.length) return frames;

  // Cepstral mean normalisation (CMN): removes channel/room effects
  const mean = new Float32Array(NUM_COEFFS);
  for (const f of frames) for (let k = 0; k < NUM_COEFFS; k++) mean[k] += f[k] / frames.length;
  for (const f of frames) for (let k = 0; k < NUM_COEFFS; k++) f[k] -= mean[k];

  return frames;
}

// ── DTW with Sakoe-Chiba band ─────────────────────────────────────────────────
function frameDist(a, b) {
  let s = 0;
  for (let k = 0; k < NUM_COEFFS; k++) { const d = a[k]-b[k]; s += d*d; }
  return Math.sqrt(s);
}

function dtw(seq1, seq2) {
  const m = seq1.length, n = seq2.length;
  if (!m || !n) return Infinity;

  // Restrict warping path to 25 % of the longer dimension
  const band = Math.max(Math.floor(Math.max(m, n) * 0.25), 5);

  // Use two rolling rows to avoid huge allocations
  let prev = new Float32Array(n).fill(Infinity);
  let curr = new Float32Array(n).fill(Infinity);

  prev[0] = frameDist(seq1[0], seq2[0]);
  for (let j = 1; j < Math.min(n, band+1); j++)
    prev[j] = prev[j-1] + frameDist(seq1[0], seq2[j]);

  for (let i = 1; i < m; i++) {
    curr.fill(Infinity);
    const jMin = Math.max(0, i - band);
    const jMax = Math.min(n - 1, i + band);
    if (jMin === 0) curr[0] = prev[0] + frameDist(seq1[i], seq2[0]);
    for (let j = Math.max(1, jMin); j <= jMax; j++) {
      const cost = frameDist(seq1[i], seq2[j]);
      curr[j] = cost + Math.min(prev[j], curr[j-1], prev[j-1]);
    }
    [prev, curr] = [curr, prev];
  }

  // Normalise by path length so longer recordings don't penalise
  return prev[n-1] / (m + n);
}

// ── Simple features (robustness backup) ──────────────────────────────────────
function globalRMS(s) {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s[i]*s[i];
  return Math.sqrt(sum / Math.max(1, s.length));
}

function rmsEnvelope(s, segs = 32) {
  const segLen = Math.max(1, Math.floor(s.length / segs));
  const env = [];
  for (let i = 0; i < segs; i++) {
    let sum = 0;
    const a = i*segLen, b = Math.min(a+segLen, s.length);
    for (let j = a; j < b; j++) sum += s[j]*s[j];
    env.push(Math.sqrt(sum/(b-a)));
  }
  const peak = Math.max(...env, 1e-10);
  return env.map(v => v/peak);
}

function cosineSim(a, b) {
  let dot=0, na=0, nb=0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) { dot+=a[i]*b[i]; na+=a[i]*a[i]; nb+=b[i]*b[i]; }
  return dot / (Math.sqrt(na)*Math.sqrt(nb) + 1e-10);
}

// ── Main comparison ───────────────────────────────────────────────────────────
/**
 * Compare two base64 WAV strings.
 * Returns integer 0–100 representing how similar the sounds are.
 * The score IS the points earned in-game.
 */
function compareSounds(b64Original, b64Mimic) {
  try {
    const orig  = parseWAV(b64Original);
    const mimic = parseWAV(b64Mimic);

    // Silence / too-short check
    const rmsO = globalRMS(orig.samples);
    const rmsM = globalRMS(mimic.samples);
    if (rmsO < 0.004) return Math.floor(Math.random() * 8 + 2);
    if (rmsM < 0.004) return Math.floor(Math.random() * 8 + 2);
    if (orig.duration < 0.15 || mimic.duration < 0.15) return 5;

    // ── MFCC + DTW  (primary, 70 % weight) ───────────────────────────────────
    const mfccO = extractMFCC(orig.samples, orig.sampleRate);
    const mfccM = extractMFCC(mimic.samples, mimic.sampleRate);

    let mfccScore = 0;
    if (mfccO.length >= 4 && mfccM.length >= 4) {
      const dist = dtw(mfccO, mfccM);
      // Exponential decay: dist≈0→1.00, dist≈2→0.51, dist≈4→0.26, dist≈8→0.07
      mfccScore = Math.exp(-dist / 3);
    }

    // ── Envelope shape  (15 % weight) ────────────────────────────────────────
    const envO = rmsEnvelope(orig.samples);
    const envM = rmsEnvelope(mimic.samples);
    const envScore = Math.max(0, cosineSim(envO, envM));

    // ── Duration ratio  (10 % weight) ────────────────────────────────────────
    const durScore = Math.min(orig.duration, mimic.duration) /
                     Math.max(orig.duration, mimic.duration, 0.1);

    // ── Overall energy ratio  (5 % weight) ───────────────────────────────────
    const rmsRatio = 1 - Math.abs(rmsO - rmsM) / Math.max(rmsO, rmsM, 1e-6);
    const energyScore = Math.max(0, rmsRatio);

    const raw = 0.70 * mfccScore + 0.15 * envScore + 0.10 * durScore + 0.05 * energyScore;

    // Tiny jitter ±2 pts so identical attempts don't look copy-pasted
    const jitter = (Math.random() - 0.5) * 0.04;
    return Math.round(Math.max(3, Math.min(97, (raw + jitter) * 100)));

  } catch (err) {
    console.error('[audioCompare] Error:', err.message);
    return Math.floor(Math.random() * 12 + 4);
  }
}

/**
 * Score commentary.
 */
function getCommentary(score) {
  if (score >= 88) return 'Eerily Identical! 👻';
  if (score >= 74) return 'Spot On! 🎯';
  if (score >= 58) return 'Pretty Close! 👍';
  if (score >= 42) return 'Getting There… 🤏';
  if (score >= 26) return 'Kinda Close? 😅';
  return 'Not Even Close! 💀';
}

module.exports = { compareSounds, getCommentary };
