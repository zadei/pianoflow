# Pitch Detection Algorithm Research for Browser-Based Piano App

## Summary

For real-time piano note detection (27.5 Hz–4186 Hz, 88 keys) in a Web Audio API context, the best
balance of accuracy and CPU cost is **MPM via pitchy inside an AudioWorklet**, with onset-gated
invocation. CREPE is the most accurate but too expensive for real-time browser use without
significant compromise.

---

## Ranked Approaches

### 1. McLeod Pitch Method (MPM) — RECOMMENDED

| Property | Value |
|---|---|
| Accuracy (piano) | High — explicitly noted as better than YIN on low frequencies |
| CPU cost | Low |
| Library | `pitchy` (npm, ESM-only, pure JS, 33 KB unpacked) |
| Buffer size | 2048 samples at 44100 Hz (~46 ms) |
| Hop size | 512–1024 samples (run every 2–4 AudioWorklet accumulation cycles) |

**Details:**
- pitchy implements MPM from McLeod & Wyvill's "A Smarter Way to Find Pitch" paper.
- `PitchDetector.forFloat32Array(2048)` returns `[frequency, clarity]`. Clarity 0–1: discard
  results below 0.9 for piano to suppress noise hits.
- Buffer size must be at least 2× the longest expected period. A4=440 Hz needs ~100 samples;
  A0=27.5 Hz needs ~1600 samples at 44100 Hz — so 2048 is the minimum safe size for full 88-key
  range.
- pitchfinder's McLeod uses `bufferSize: 1024` by default with `cutoff: 0.93` (93% of peak height
  threshold).

```js
import { PitchDetector } from "https://esm.sh/pitchy@4";
const detector = PitchDetector.forFloat32Array(2048);
const [pitch, clarity] = detector.findPitch(float32Buffer, 44100);
if (clarity > 0.9 && pitch > 27 && pitch < 4200) {
  const midi = Math.round(12 * Math.log2(pitch / 440) + 69);
}
```

---

### 2. YIN Algorithm

| Property | Value |
|---|---|
| Accuracy (piano) | High — best overall balance per pitchfinder docs |
| CPU cost | Low–Medium |
| Library | `pitchfinder` (npm, YIN + McLeod + AMDF + DynamicWavelet) |
| Buffer size | 1024–2048 samples |
| Hop size | 512 samples |

**Details:**
- YIN can produce "wildly incorrect" outlier values (octave errors). Needs post-processing:
  median filter over 3–5 frames, or compare against previous frame and reject >1 semitone jumps.
- `Pitchfinder.YIN({ sampleRate: 44100, threshold: 0.1, probabilityThreshold: 0.1 })`
- Slightly more CPU than MPM because it computes a difference function over the full lag range.
- For piano, MPM (pitchy) is preferred due to better low-frequency performance.

---

### 3. AudioWorklet Offloading (Architecture, not algorithm)

| Property | Value |
|---|---|
| Benefit | Moves detection fully off main thread |
| CPU cost | No change to algorithm cost; eliminates main-thread jank |
| Browser support | Baseline "Widely available" since April 2021 |

**Correct pattern:**

```js
// pitch-worklet.js (separate file, runs on audio thread)
class PitchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(2048);
    this._pos = 0;
  }
  process(inputs) {
    const input = inputs[0][0]; // 128 samples per call
    if (!input) return true;
    this._buf.set(input, this._pos);
    this._pos += 128;
    if (this._pos >= 2048) {
      this._pos = 0;
      this.port.postMessage({ buffer: this._buf.slice() });
    }
    return true;
  }
}
registerProcessor("pitch-processor", PitchProcessor);

// main thread
await audioContext.audioWorklet.addModule("pitch-worklet.js");
const workletNode = new AudioWorkletNode(audioContext, "pitch-processor");
workletNode.port.onmessage = ({ data }) => {
  const [pitch, clarity] = detector.findPitch(data.buffer, audioContext.sampleRate);
  // map to MIDI, update UI
};
micSource.connect(workletNode);
```

Note: `process()` is called with 128-frame blocks. At 44100 Hz, 2048 samples = 16 calls to
accumulate before running pitch detection (~46 ms latency).

---

### 4. Onset Detection + Frame Skipping (Throttle Strategy)

| Property | Value |
|---|---|
| CPU reduction | 60–80% — only run pitch on note attacks |
| Accuracy impact | None if onset detection is accurate |
| Library | Manual RMS threshold, or aubio (C lib, Python only — not browser WASM) |

**Best practice for piano:**

Piano notes have sharp attacks. Use RMS energy to detect onset, then run pitch detection for
~200 ms after attack, then stop until next onset.

```js
function rms(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / buffer.length);
}

const ONSET_THRESHOLD = 0.01; // tune per environment
let lastOnsetTime = 0;
const HOLD_MS = 250;

workletNode.port.onmessage = ({ data }) => {
  const energy = rms(data.buffer);
  const now = performance.now();
  if (energy > ONSET_THRESHOLD || now - lastOnsetTime < HOLD_MS) {
    if (energy > ONSET_THRESHOLD) lastOnsetTime = now;
    const [pitch, clarity] = detector.findPitch(data.buffer, audioContext.sampleRate);
    // process pitch
  }
};
```

Additional throttle: accumulate 4096 samples instead of 2048 (92 ms) for lower CPU at slight
latency cost, acceptable for learning apps.

---

### 5. WASM-based Pitch Detection (aubio.js)

| Property | Value |
|---|---|
| Accuracy (piano) | High (YIN + onset detection combined) |
| CPU cost | Medium — WASM overhead + algorithm |
| Library | `aubio.js` (unofficial Emscripten port) — maintenance status uncertain |
| Buffer size | 512–2048 samples |

**Details:**
- aubio (C library) supports `aubioonset` + `aubiopitch` together, which is ideal — run pitch
  only on detected onsets.
- The JS/WASM port exists but is not officially maintained. Check
  https://github.com/qiuxiang/aubio.js for current status.
- Adds ~500 KB WASM bundle. Use only if pure-JS accuracy is insufficient.
- If using: call `Aubio.Pitch("yin", bufferSize, hopSize, sampleRate)` inside the worklet.

---

### 6. CREPE (CNN-based) — NOT RECOMMENDED for real-time browser use

| Property | Value |
|---|---|
| Accuracy (piano) | Very high (~4 cents RMS error on full model) |
| CPU cost | Very high |
| Library | TensorFlow.js port exists (crepe-js / unofficial) |
| Buffer size | 1024 samples (fixed) |
| Latency | 50–500 ms per inference depending on model size and device |

**Details:**
- CREPE uses a deep CNN with 5 model sizes: tiny/small/medium/large/full.
- Even the "tiny" model is too slow for frame-by-frame real-time detection on average hardware.
- Use case: batch analysis of recorded audio after the fact, not live detection.
- The Python/command-line version uses 10 ms time steps by default.
- TensorFlow.js model weights must be loaded (~2–30 MB depending on size).
- Verdict: skip for live piano apps. Consider only for offline score evaluation.

---

### 7. AMDF / Dynamic Wavelet — NOT RECOMMENDED for piano

| Property | Value |
|---|---|
| AMDF accuracy | Only ±2% — too coarse for semitone-accurate piano detection |
| Dynamic Wavelet | Very fast but "struggles to identify lower frequencies" — A0–C3 range will fail |

Both are available in `pitchfinder` but unsuitable for full 88-key piano range.

---

## Final Recommendation

**Primary:** pitchy (MPM) inside an AudioWorklet, buffer 2048, clarity threshold 0.9,
onset-gated with RMS energy check.

**Fallback validation:** run YIN (pitchfinder) in parallel on ambiguous frames (clarity 0.7–0.9)
and take the consensus — but only if CPU budget allows.

**Do not use:** CREPE for real-time, Dynamic Wavelet or AMDF for piano.

---

## Key Numbers

| Algorithm | Min buffer for A0 (27.5 Hz) at 44100 Hz | Recommended buffer | Hop |
|---|---|---|---|
| MPM (pitchy) | 1603 samples | 2048 | 512–1024 |
| YIN (pitchfinder) | 1603 samples | 2048 | 512 |
| CREPE | 1024 (fixed) | 1024 | 441 (10 ms) |
| AMDF | 2048 | 2048 | 512 |

Formula for minimum buffer: `ceil(sampleRate / lowestFreq) * 2` = `ceil(44100 / 27.5) * 2` = 3207
samples. Use 4096 if targeting A0 reliably.

---

## Libraries

| Library | Algorithm | Size | npm |
|---|---|---|---|
| pitchy | MPM | 33 KB | `npm install pitchy` |
| pitchfinder | YIN, MPM, AMDF, DynWavelet | small | `npm install pitchfinder` |
| aubio.js | YIN + onset (WASM) | ~500 KB | check GitHub |
| crepe-js | CNN (TF.js) | 2–30 MB | not on npm officially |
