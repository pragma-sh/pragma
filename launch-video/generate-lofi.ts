import { writeFile } from "node:fs/promises";

const sampleRate = 44_100;
const tempo = 80;
const beatSeconds = 60 / tempo;
const durationSeconds = beatSeconds * 16;
const samples = new Float32Array(Math.ceil(sampleRate * durationSeconds));

let randomState = 0x51f15e;
function random() {
  randomState = (randomState * 1_664_525 + 1_013_904_223) >>> 0;
  return randomState / 0x1_0000_0000;
}

function addKeys(start: number, duration: number, frequency: number, gain: number) {
  const firstSample = Math.floor(start * sampleRate);
  const sampleCount = Math.floor(duration * sampleRate);

  for (let offset = 0; offset < sampleCount && firstSample + offset < samples.length; offset += 1) {
    const time = offset / sampleRate;
    const attack = Math.min(1, time / 0.06);
    const release = Math.min(1, (duration - time) / 0.8);
    const envelope = attack * release * Math.exp(-time * 0.12);
    const phase = Math.PI * 2 * frequency * time;
    const tremolo = 0.96 + 0.04 * Math.sin(Math.PI * 2 * 0.7 * time);
    samples[firstSample + offset]! +=
      gain *
      envelope *
      tremolo *
      (Math.sin(phase) + 0.2 * Math.sin(phase * 2) + 0.06 * Math.sin(phase * 3));
  }
}

function addKick(start: number) {
  const firstSample = Math.floor(start * sampleRate);
  const sampleCount = Math.floor(0.5 * sampleRate);
  let phase = 0;

  for (let offset = 0; offset < sampleCount && firstSample + offset < samples.length; offset += 1) {
    const time = offset / sampleRate;
    const frequency = 48 + 72 * Math.exp(-time * 28);
    phase += (Math.PI * 2 * frequency) / sampleRate;
    samples[firstSample + offset]! += 0.32 * Math.sin(phase) * Math.exp(-time * 11);
  }
}

function addNoiseHit(start: number, duration: number, gain: number) {
  const firstSample = Math.floor(start * sampleRate);
  const sampleCount = Math.floor(duration * sampleRate);
  let previous = 0;

  for (let offset = 0; offset < sampleCount && firstSample + offset < samples.length; offset += 1) {
    const time = offset / sampleRate;
    const noise = random() * 2 - 1;
    const highPass = noise - previous * 0.82;
    previous = noise;
    const attack = Math.min(1, time / 0.008);
    samples[firstSample + offset]! += gain * highPass * attack * Math.exp((-time * 7) / duration);
  }
}

const progression = [
  { chord: [146.83, 185, 220, 277.18], bass: 73.42 },
  { chord: [123.47, 146.83, 185, 220], bass: 61.74 },
  { chord: [98, 123.47, 146.83, 185], bass: 49 },
  { chord: [110, 138.59, 164.81, 196], bass: 55 },
] as const;

for (const [bar, harmony] of progression.entries()) {
  const start = bar * beatSeconds * 4;
  for (const frequency of harmony.chord) addKeys(start, beatSeconds * 3.85, frequency, 0.045);
  addKeys(start, beatSeconds * 1.8, harmony.bass, 0.1);
  addKeys(start + beatSeconds * 2, beatSeconds * 1.7, harmony.bass, 0.08);
}

for (let beat = 0; beat < 16; beat += 1) {
  const start = beat * beatSeconds;
  if (beat % 4 === 0 || beat % 4 === 2) addKick(start);
  if (beat % 4 === 1 || beat % 4 === 3) addNoiseHit(start, 0.2, 0.075);
  addNoiseHit(start, 0.08, beat % 2 === 0 ? 0.018 : 0.012);
  addNoiseHit(start + beatSeconds / 2, 0.06, 0.01);
}

let vinyl = 0;
for (let index = 0; index < samples.length; index += 1) {
  vinyl = vinyl * 0.94 + (random() * 2 - 1) * 0.06;
  samples[index]! += vinyl * 0.012;
}

let peak = 0;
for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
const normalization = Math.min(0.9 / peak, 1);
const dataSize = samples.length * 2;
const wav = Buffer.alloc(44 + dataSize);

wav.write("RIFF", 0);
wav.writeUInt32LE(36 + dataSize, 4);
wav.write("WAVE", 8);
wav.write("fmt ", 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(dataSize, 40);

for (let index = 0; index < samples.length; index += 1) {
  const sample = Math.max(-1, Math.min(1, samples[index]! * normalization));
  wav.writeInt16LE(Math.round(sample * 32_767), 44 + index * 2);
}

const output = new URL("../apps/www/public/media/pragma-lofi.wav", import.meta.url);
await writeFile(output, wav);
