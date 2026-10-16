'use strict';

// Pure-JS audio similarity engine for Noise Mimic mode.
// Compares two base64-encoded WAV buffers and returns a 0-100 match score.

function parseWAV(base64) {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length < 44) throw new Error('Buffer too small for WAV');

  const numChannels = buf.readUInt16LE(22);
  const sampleRate  = buf.readUInt32LE(24);
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

function rmsEnvelope(samples, segs = 24) {
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
function peakProfile(env, topN = 5) {
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

/**
 * Compare two base64 WAV strings.
 * Returns integer score 0–100.
 */
function compareSounds(b64Original, b64Mimic) {
  try {
    const orig  = parseWAV(b64Original);
    const mimic = parseWAV(b64Mimic);

    // 1. Duration similarity (0–1)
    const maxDur = Math.max(orig.duration, mimic.duration, 0.05);
    const minDur = Math.min(orig.duration, mimic.duration);
    const durScore = minDur / maxDur;

    // 2. RMS envelope cosine similarity (0–1)
    const envO = rmsEnvelope(orig.samples);
    const envM = rmsEnvelope(mimic.samples);
    const envScore = Math.max(0, cosineSim(envO, envM));

    // 3. Zero-crossing rate similarity (0–1)
    const zcrO = zeroCrossRate(orig.samples);
    const zcrM = zeroCrossRate(mimic.samples);
    const zcrMax = Math.max(zcrO, zcrM, 0.001);
    const zcrScore = Math.max(0, 1 - Math.abs(zcrO - zcrM) / zcrMax);

    // 4. Peak timing similarity (0–1)
    const pkScore = peakSim(peakProfile(envO), peakProfile(envM));

    // Weighted combination
    const raw = 0.25 * durScore + 0.40 * envScore + 0.15 * zcrScore + 0.20 * pkScore;

    // Add small jitter so scores feel organic (±6 pts)
    const jitter = (Math.random() - 0.5) * 0.12;
    const score  = Math.round(Math.max(4, Math.min(97, (raw + jitter) * 100)));

    return score;
  } catch (err) {
    console.error('[audioCompare] Error:', err.message);
    return Math.floor(Math.random() * 45 + 15); // graceful fallback
  }
}

/**
 * Score commentary based on percentage.
 */
function getCommentary(score) {
  if (score >= 90) return 'Eerily Identical! 👻';
  if (score >= 75) return 'Spot On! 🎯';
  if (score >= 60) return 'Decent Impression 👍';
  if (score >= 45) return 'Getting There... 🤏';
  if (score >= 30) return 'Kinda Close? 😅';
  return 'Not Even Close! 💀';
}

module.exports = { compareSounds, getCommentary };
