/**
 * AudioWorklet processor for pitch detection using YIN algorithm.
 * Runs in the audio thread for consistent low-latency callbacks.
 *
 * NOTE: This file must be loaded via audioWorklet.addModule(), not as a regular script.
 */

class PitchProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.bufferSize = 2048;
        this.buffer = new Float32Array(this.bufferSize);
        this.writeIndex = 0;
        this.filled = false;
        // Increased from 256 → 512: halves analysis frequency (~11.6ms at 44100Hz)
        // while remaining imperceptibly fast to a human player.
        this.hopSize = 512;
        this.hopCount = 0;
        this.threshold = 0.10;        // YIN threshold (slightly lower = more sensitive)
        this.volumeThreshold = 0.005; // Minimum RMS to bother detecting pitch

        // Pre-allocated working buffers — eliminates 3× Float32Array allocs per analysis
        this._linearBuf = new Float32Array(this.bufferSize);
        this._d          = new Float32Array(Math.floor(this.bufferSize / 2));
        this._dPrime     = new Float32Array(Math.floor(this.bufferSize / 2));

        this.port.onmessage = (e) => {
            if (e.data.type === 'setVolumeThreshold') {
                this.volumeThreshold = e.data.value;
            }
        };
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || !input[0]) return true;

        const samples = input[0];

        for (let i = 0; i < samples.length; i++) {
            this.buffer[this.writeIndex] = samples[i];
            this.writeIndex = (this.writeIndex + 1) % this.bufferSize;

            if (!this.filled && this.writeIndex === 0) {
                this.filled = true;
            }

            if (this.filled) {
                this.hopCount++;
                if (this.hopCount >= this.hopSize) {
                    this.hopCount = 0;
                    this._analyze();
                }
            }
        }

        return true;
    }

    _analyze() {
        // RMS check directly on the ring buffer — no allocation or copy needed.
        // If silent, bail out before paying the cost of linearizing the ring buffer.
        let sumSq = 0;
        const buf = this.buffer;
        const n   = this.bufferSize;
        for (let i = 0; i < n; i++) {
            const s = buf[i];
            sumSq += s * s;
        }
        const rms = Math.sqrt(sumSq / n);

        if (rms < this.volumeThreshold) {
            this.port.postMessage({ type: 'pitch', frequency: -1, rms });
            return;
        }

        // Linearize ring buffer into pre-allocated buffer (oldest sample first)
        const wi  = this.writeIndex;
        const lin = this._linearBuf;
        for (let i = 0; i < n; i++) {
            lin[i] = buf[(wi + i) % n];
        }

        const frequency = this._yin(lin, sampleRate);
        this.port.postMessage({ type: 'pitch', frequency, rms });
    }

    /**
     * YIN pitch detection algorithm.
     * Returns detected frequency in Hz, or -1 if no pitch found.
     * Uses pre-allocated buffers — zero heap allocation in the hot path.
     */
    _yin(buffer, sr) {
        const halfLen = Math.floor(buffer.length / 2);
        const d      = this._d;
        const dPrime = this._dPrime;

        // Step 2: Difference function
        for (let tau = 0; tau < halfLen; tau++) {
            let sum = 0;
            for (let i = 0; i < halfLen; i++) {
                const diff = buffer[i] - buffer[i + tau];
                sum += diff * diff;
            }
            d[tau] = sum;
        }

        // Step 3: Cumulative mean normalised difference
        dPrime[0] = 1;
        let runningSum = 0;
        for (let tau = 1; tau < halfLen; tau++) {
            runningSum += d[tau];
            dPrime[tau] = d[tau] * tau / runningSum;
        }

        // Steps 4–5: Absolute threshold + minimum search + parabolic interpolation
        let tau = 2;
        while (tau < halfLen) {
            if (dPrime[tau] < this.threshold) {
                while (tau + 1 < halfLen && dPrime[tau + 1] < dPrime[tau]) {
                    tau++;
                }
                const s0 = tau > 0         ? dPrime[tau - 1] : dPrime[tau];
                const s1 = dPrime[tau];
                const s2 = tau + 1 < halfLen ? dPrime[tau + 1] : dPrime[tau];
                const denom = 2 * (s0 - 2 * s1 + s2);
                const shift = denom === 0 ? 0 : (s0 - s2) / denom;
                return sr / (tau + shift);
            }
            tau++;
        }

        return -1; // No pitch detected
    }
}

registerProcessor('pitch-processor', PitchProcessor);
