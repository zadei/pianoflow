/**
 * SynthPlayer — plays note sequences using Web Audio API oscillators.
 * Piano-like tone: fast attack, exponential decay to sustain, short release.
 */
class SynthPlayer {
    constructor() {
        this.audioCtx = null;
        this.playing = false;
        this._nodes = [];
        this._stopTimeout = null;
    }

    _midiToFreq(midi) {
        return 440 * Math.pow(2, (midi - 69) / 12);
    }

    /**
     * Play a note sequence starting at a given beat offset.
     * @param {Array}    notes            - [{midi_number, start_beat, duration_beats}]
     * @param {number}   tempoBPM
     * @param {number}   tempoMultiplier
     * @param {number}   startBeat        - current beat (notes before this are skipped)
     * @param {Function} [onComplete]     - called when playback ends naturally
     */
    play(notes, tempoBPM, tempoMultiplier, startBeat, onComplete) {
        this.stop();
        if (!notes || notes.length === 0) return;

        this.audioCtx = new AudioContext();
        this.playing = true;

        // Compressor prevents clipping when many notes overlap (polyphonic sum > 1.0)
        this._compressor = this.audioCtx.createDynamicsCompressor();
        this._compressor.threshold.value = -12;
        this._compressor.knee.value = 6;
        this._compressor.ratio.value = 4;
        this._compressor.attack.value = 0.003;
        this._compressor.release.value = 0.1;
        this._compressor.connect(this.audioCtx.destination);

        const beatsPerSec = (tempoBPM * tempoMultiplier) / 60;
        const now = this.audioCtx.currentTime;
        let lastEndSec = 0;

        for (const note of notes) {
            // Schedule relative to startBeat so audio stays in sync with the visual
            const delaySec = (note.start_beat - startBeat) / beatsPerSec;
            if (delaySec < -0.05) continue; // already passed

            const durationSec = Math.max(0.08, note.duration_beats / beatsPerSec);
            const freq = this._midiToFreq(note.midi_number);
            const startTime = now + delaySec;

            // Oscillator 1 — triangle fundamental
            const osc1 = this.audioCtx.createOscillator();
            osc1.type = 'triangle';
            osc1.frequency.value = freq;

            // Oscillator 2 — sine 2nd harmonic for added brightness/warmth
            const osc2 = this.audioCtx.createOscillator();
            osc2.type = 'sine';
            osc2.frequency.value = freq * 2;
            osc2.detune.value = 3; // slight warmth

            // Gain envelope for fundamental: attack → steep decay → sustain → release
            const gain = this.audioCtx.createGain();
            gain.gain.setValueAtTime(0, startTime);
            gain.gain.linearRampToValueAtTime(0.28, startTime + 0.012);                    // attack
            gain.gain.exponentialRampToValueAtTime(0.08, startTime + 0.12);               // steeper decay
            const releaseEnd = startTime + durationSec + 0.06;
            const sustainEnd = Math.min(startTime + Math.max(0.15, durationSec - 0.06), releaseEnd - 0.01);
            gain.gain.exponentialRampToValueAtTime(0.04, sustainEnd);                      // sustain
            gain.gain.linearRampToValueAtTime(0.0001, releaseEnd);                         // release

            // Gain envelope for 2nd harmonic — lower volume, decays faster
            const gain2 = this.audioCtx.createGain();
            gain2.gain.setValueAtTime(0.15, startTime);
            gain2.gain.exponentialRampToValueAtTime(0.0001, startTime + durationSec * 0.7);

            osc1.connect(gain);
            osc2.connect(gain2);
            gain.connect(this._compressor);
            gain2.connect(this._compressor);

            osc1.start(startTime); osc1.stop(startTime + durationSec + 0.1);
            osc2.start(startTime); osc2.stop(startTime + durationSec * 0.7);

            this._nodes.push({ osc: osc1, gain }, { osc: osc2, gain: gain2 });

            const endSec = delaySec + durationSec;
            if (endSec > lastEndSec) lastEndSec = endSec;
        }

        // Fire onComplete after all notes finish
        this._stopTimeout = setTimeout(() => {
            this.playing = false;
            if (onComplete) onComplete();
        }, (lastEndSec + 0.6) * 1000);
    }

    stop() {
        this.playing = false;
        if (this._stopTimeout) {
            clearTimeout(this._stopTimeout);
            this._stopTimeout = null;
        }
        for (const { osc } of this._nodes) {
            try { osc.stop(0); } catch (_) {}
        }
        this._nodes = [];
        if (this.audioCtx) {
            this.audioCtx.close();
            this.audioCtx = null;
        }
    }
}
