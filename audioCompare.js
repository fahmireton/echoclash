'use strict';

// Pure-JS audio similarity engine for Noise Mimic mode.
// Compares two base64-encoded WAV buffers and returns a 0-100 match score.

function parseWAV(base64) {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length < 44) throw new Error('Buffer too small for WAV');

  const numChannels  = buf.readUInt16LE(22);
  const sampleRate   = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);

  // Scan for 'data' sub-chunk (handles non-standard headers)
  let dataStart = 44;
  let dataSize  = buf.length - 44;
  let offset = 12;
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

function globalRMS(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function rmsEnvelope(samples, segs = 36) {
  const segLen = Math.max(1, Math.floor(samples.length / segs));
  const env = [];
  for (let i = 0; i < segs; i++) {
    let sum = 0;
    const start = i * segLen;
    const end   = Math.min(start + segLen, samples.length);
    for (let j = start; j < end; j++) sum += samples[j] * samples[j];
    env.push(Math.sqrt(sum / (end - start)));
  }
  const peak = Math.max(...env, 1e-10);
  return env.map(v => v / peak);
}

function zeroCrossRate(samples) {
  let c = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i] >= 0) !== (samples[i - 1] >= 0)) c++;
  }
  return c / samples.length;
}

// Windowed ZCR profile — approximates spectral centroid over time
// Higher ZCR per window ≈ more high-frequency content in that segment
function spectralProfile(samples, segs = 24) {
  const segLen = Math.max(1, Math.floor(samples.length / segs));
  const profile = [];
  for (let i = 0; i < segs; i++) {
    const start = i * segLen;
    const end   = Math.min(start + segLen, samples.length);
    let zcr = 0;
    for (let j = start + 1; j < end; j++) {
      if ((samples[j] >= 0) !== (samples[j - 1] >= 0)) zcr++;
    }
    profile.push(zcr / Math.max(1, end - start));
  }
  const peak = Math.max(...profile, 1e-10);
  return profile.map(v => v / peak);
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

// Peak timing profile: where the loudest segments occur (rhythm/timing match)
function peakProfile(env, topN = 6) {
  return env
    .map((v, i) => ({ v, i }))
    .sort((a, b) => b.v - a.v)
    .slice(0, topN)
    .map(x => x.i / env.length)
    .sort((a, b) => a - b);
}

function peakSim(pA, pB) {
  if (!pA.length || !pB.length) return 0;
  let totalDist = 0;
  const len = Math.min(pA.length, pB.length);
  for (let i = 0; i < len; i++) totalDist += Math.abs(pA[i] - pB[i]);
  return Math.max(0, 1 - totalDist / len);
}

// Attack/decay shape: normalised first and last quarter energy ratio
function attackDecayScore(env) {
  const q = Math.max(1, Math.floor(env.length / 4));
  const front = env.slice(0, q).reduce((a, v) => a + v, 0) / q;
  const back  = env.slice(-q).reduce((a, v) => a + v, 0) / q;
  return { front, back };
}

/**
 * Compare two base64 WAV strings.
 * Returns integer score 0–100 where the score IS the accuracy percentage.
 */
function compareSounds(b64Original, b64Mimic) {
  try {
    const orig  = parseWAV(b64Original);
    const mimic = parseWAV(b64Mimic);

    // Silence check — if either signal is essentially silent, score very low
    const rmsO = globalRMS(orig.samples);
    const rmsM = globalRMS(mimic.samples);
    if (rmsO < 0.005) return Math.floor(Math.random() * 10 + 3);
    if (rmsM < 0.005) return Math.floor(Math.random() * 10 + 3);

    // 1. Duration similarity (0–1)
    const maxDur  = Math.max(orig.duration, mimic.duration, 0.1);
    const minDur  = Math.min(orig.duration, mimic.duration);
    const durScore = minDur / maxDur;

    // 2. RMS envelope cosine similarity (0–1) — 36 segments
    const envO = rmsEnvelope(orig.samples, 36);
    const envM = rmsEnvelope(mimic.samples, 36);
    const envScore = Math.max(0, cosineSim(envO, envM));

    // 3. Zero-crossing rate similarity (0–1)
    const zcrO   = zeroCrossRate(orig.samples);
    const zcrM   = zeroCrossRate(mimic.samples);
    const zcrMax = Math.max(zcrO, zcrM, 0.001);
    const zcrScore = Math.max(0, 1 - Math.abs(zcrO - zcrM) / zcrMax);

    // 4. Peak timing similarity (0–1)
    const pkScore = peakSim(peakProfile(envO), peakProfile(envM));

    // 5. Spectral centroid profile similarity (0–1)
    const spO = spectralProfile(orig.samples);
    const spM = spectralProfile(mimic.samples);
    const spScore = Math.max(0, cosineSim(spO, spM));

    // 6. Attack/decay shape similarity (0–1)
    const adO = attackDecayScore(envO);
    const adM = attackDecayScore(envM);
    const adScore = 1 - (Math.abs(adO.front - adM.front) + Math.abs(adO.back - adM.back)) / 2;

    // Weighted combination — envelope & spectral carry most weight
    const raw = (
      0.10 * durScore  +
      0.28 * envScore  +
      0.12 * zcrScore  +
      0.22 * pkScore   +
      0.18 * spScore   +
      0.10 * adScore
    );

    // Tiny jitter ±2 pts for organic feel
    const jitter = (Math.random() - 0.5) * 0.04;
    const score  = Math.round(Math.max(4, Math.min(96, (raw + jitter) * 100)));

    return score;
  } catch (err) {
    console.error('[audioCompare] Error:', err.message);
    return Math.floor(Math.random() * 15 + 5);
  }
}

/**
 * Score commentary based on percentage.
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
