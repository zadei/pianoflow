/**
 * AudioWorklet processor for Basic Pitch polyphonic detection.
 *
 * Accumulates raw PCM into ~2-second windows (with 50% overlap) and posts
 * each window to the main thread for forwarding to the pitch Web Worker.
 *
 * Basic Pitch expects 22050 Hz mono audio. We capture at the native rate
 * and let the Worker resample, so we send the native sampleRate along.
 *
 * NOTE: Load via audioWorklet.addModule(), not as a regular script.
 */
class MicProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        // ~2 seconds at native rate (e.g. 44100 * 2 = 88200 samples).
        // The worker will resample to 22050 Hz.
        this.windowSeconds = 2;
        this.frameSize = Math.round(sampleRate * this.windowSeconds);
        this.hopSize = Math.round(this.frameSize / 2); // 50% overlap → ~1 sec hop

        this.buffer = new Float32Array(this.frameSize);
        this.writeIndex = 0;
        this.filled = false;
        this.samplesSinceEmit = 0;
        this.active = true;

        this.port.onmessage = (e) => {
            if (e.data.type === 'stop') {
                this.active = false;
            }
        };
    }

    process(inputs) {
        if (!this.active) return false;

        const input = inputs[0];
        if (!input || !input[0]) return true;

        const samples = input[0];

        for (let i = 0; i < samples.length; i++) {
            this.buffer[this.writeIndex] = samples[i];
            this.writeIndex = (this.writeIndex + 1) % this.frameSize;

            if (!this.filled && this.writeIndex === 0) {
                this.filled = true;
            }

            if (this.filled) {
                this.samplesSinceEmit++;
                if (this.samplesSinceEmit >= this.hopSize) {
                    this.samplesSinceEmit = 0;
                    this._emitFrame();
                }
            }
        }

        return true;
    }

    /**
     * Linearize the ring buffer and post the window to the main thread.
     */
    _emitFrame() {
        const frame = new Float32Array(this.frameSize);
        for (let i = 0; i < this.frameSize; i++) {
            frame[i] = this.buffer[(this.writeIndex + i) % this.frameSize];
        }

        this.port.postMessage(
            { type: 'audioFrame', frame, sampleRate },
            [frame.buffer]
        );
    }
}

registerProcessor('mic-processor', MicProcessor);
