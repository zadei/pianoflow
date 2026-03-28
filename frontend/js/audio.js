/**
 * Microphone setup and audio pipeline management.
 */
class AudioManager {
    constructor() {
        this.audioCtx = null;
        this.stream = null;
        this.workletNode = null;
        this.active = false;
        this.onPitch = null; // callback: (frequency, rms) => void
        this.metronomeActive = false;
        this._metronomeTimeout = null;

        // Basic Pitch polyphonic pipeline
        this._bpWorkletNode = null;
        this._bpWorker = null;
        this._bpReady = false;
        this.onNotes = null; // callback: (midiNotes: number[]) => void

        // Web MIDI keyboard input
        this._midiAccess = null;
        this._midiActiveNotes = new Set(); // currently held MIDI note numbers
        this.onMidiNotes = null; // callback: (midiNotes: number[]) => void
        this.midiConnected = false;
    }

    /**
     * Initialize Web MIDI API to receive input from connected MIDI keyboards.
     * MIDI gives instant, perfect multi-note detection — no ML latency.
     * @returns {Promise<boolean>} true if MIDI access granted and inputs found
     */
    async initMidi() {
        if (!navigator.requestMIDIAccess) {
            console.log('[MIDI] Web MIDI API not supported in this browser');
            return false;
        }
        try {
            this._midiAccess = await navigator.requestMIDIAccess();
            this._bindMidiInputs();
            // Re-bind when devices are plugged in/out
            this._midiAccess.onstatechange = () => this._bindMidiInputs();
            return this.midiConnected;
        } catch (err) {
            console.warn('[MIDI] Access denied or unavailable:', err.message);
            return false;
        }
    }

    /**
     * Bind event listeners to all available MIDI input ports.
     */
    _bindMidiInputs() {
        if (!this._midiAccess) return;
        let found = false;
        for (const input of this._midiAccess.inputs.values()) {
            input.onmidimessage = (e) => this._handleMidiMessage(e);
            found = true;
            console.log(`[MIDI] Connected: ${input.name}`);
        }
        this.midiConnected = found;
    }

    /**
     * Handle a raw MIDI message — track noteOn/noteOff and emit active notes.
     */
    _handleMidiMessage(event) {
        const [status, note, velocity] = event.data;
        const command = status & 0xf0;

        if (command === 0x90 && velocity > 0) {
            // noteOn
            this._midiActiveNotes.add(note);
        } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
            // noteOff
            this._midiActiveNotes.delete(note);
        } else {
            return; // ignore other messages (CC, pitch bend, etc.)
        }

        // Emit current set of held notes
        if (this.onMidiNotes) {
            this.onMidiNotes(Array.from(this._midiActiveNotes).sort((a, b) => a - b));
        }
    }

    /**
     * Stop MIDI input listeners.
     */
    stopMidi() {
        if (this._midiAccess) {
            for (const input of this._midiAccess.inputs.values()) {
                input.onmidimessage = null;
            }
        }
        this._midiActiveNotes.clear();
        this.midiConnected = false;
    }

    /**
     * Initialize audio context and request microphone access.
     * @returns {Promise<boolean>} true if mic access granted
     */
    async init() {
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                },
            });

            this.audioCtx = new AudioContext();
            const source = this.audioCtx.createMediaStreamSource(this.stream);

            // Load the AudioWorklet
            await this.audioCtx.audioWorklet.addModule('/js/pitch-worklet.js');
            this.workletNode = new AudioWorkletNode(this.audioCtx, 'pitch-processor');

            this.workletNode.port.onmessage = (e) => {
                if (e.data.type === 'pitch' && this.onPitch) {
                    this.onPitch(e.data.frequency, e.data.rms);
                }
            };

            source.connect(this.workletNode);
            // Don't connect to destination — we don't want to play mic back
            this.active = true;
            return true;
        } catch (err) {
            console.error('Microphone access failed:', err);
            return false;
        }
    }

    /**
     * Set the volume threshold for pitch detection.
     * @param {number} value - RMS threshold (0.0 to 1.0)
     */
    setVolumeThreshold(value) {
        if (this.workletNode) {
            this.workletNode.port.postMessage({ type: 'setVolumeThreshold', value });
        }
    }

    /**
     * Play a brief dissonant buzz for a wrong note during practice mode.
     * Uses the existing AudioContext if available, otherwise creates a one-shot context.
     */
    playWrongNote() {
        const ctx = this.audioCtx || new AudioContext();
        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = 220.5; // slightly detuned for dissonance

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 600;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + 0.15);

        // If we created a temporary context, close it after the note ends
        if (!this.audioCtx) {
            setTimeout(() => ctx.close(), 300);
        }
    }

    /**
     * Play a soft bright chime confirming a correct note hit.
     * @param {number} midi - MIDI note number to play at correct pitch
     */
    playCorrectNote(midi) {
        const ctx = this.audioCtx || new AudioContext();
        const now = ctx.currentTime;
        const freq = 440 * Math.pow(2, (midi - 69) / 12);

        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.1, now + 0.08);  // attack
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2); // decay to end

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + 0.2);

        if (!this.audioCtx) {
            setTimeout(() => ctx.close(), 400);
        }
    }

    /**
     * Start a metronome click at the given tempo.
     * @param {number} tempoBPM
     * @param {number} tempoMultiplier
     */
    startMetronome(tempoBPM, tempoMultiplier) {
        this.stopMetronome();
        this.metronomeActive = true;
        const intervalMs = (60 / (tempoBPM * tempoMultiplier)) * 1000;

        const click = () => {
            if (!this.metronomeActive) return;
            const ctx = this.audioCtx;
            if (ctx) {
                const now = ctx.currentTime;
                const osc = ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.value = 880;

                const gain = ctx.createGain();
                gain.gain.setValueAtTime(0.08, now);
                gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);

                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(now);
                osc.stop(now + 0.05);
            }
            this._metronomeTimeout = setTimeout(click, intervalMs);
        };

        this._metronomeTimeout = setTimeout(click, intervalMs);
    }

    /**
     * Stop the metronome.
     */
    stopMetronome() {
        this.metronomeActive = false;
        if (this._metronomeTimeout) {
            clearTimeout(this._metronomeTimeout);
            this._metronomeTimeout = null;
        }
    }

    /**
     * Initialize the Basic Pitch polyphonic detection pipeline.
     *
     * Sets up:
     *  1. mic-processor.js AudioWorklet (chunks raw audio)
     *  2. pitch-worker.js  Web Worker   (runs ML inference)
     *  3. Message routing:  Worklet → main thread → Worker → main thread
     *
     * Requires init() to have been called first (needs audioCtx + stream).
     * Detected notes arrive via this.onNotes(midiNotes).
     *
     * @returns {Promise<boolean>} true if pipeline is set up
     */
    async initBasicPitch() {
        if (!this.audioCtx || !this.stream) {
            console.error('[AudioManager] Call init() before initBasicPitch()');
            return false;
        }

        try {
            // 1. Load the mic-processor AudioWorklet
            await this.audioCtx.audioWorklet.addModule('/js/mic-processor.js');
            this._bpWorkletNode = new AudioWorkletNode(
                this.audioCtx,
                'mic-processor'
            );

            // 2. Spin up the pitch Web Worker (classic worker — uses importScripts)
            this._bpWorker = new Worker('/js/pitch-worker.js');

            // 3. Worker → main thread: relay detected notes
            this._bpWorker.onmessage = (e) => {
                if (e.data.type === 'ready') {
                    this._bpReady = true;
                    console.log('[BasicPitch] Model loaded and ready');
                } else if (e.data.type === 'notes' && this.onNotes) {
                    // Worker sends { type: 'notes', midiNotes: number[] }
                    const midiNotes = e.data.midiNotes || [];
                    if (midiNotes.length > 0) {
                        this.onNotes(midiNotes);
                    }
                } else if (e.data.type === 'error') {
                    console.error('[BasicPitch]', e.data.message);
                }
            };

            // 4. Worklet → main thread → Worker: forward audio frames
            this._bpWorkletNode.port.onmessage = (e) => {
                if (e.data.type === 'audioFrame' && this._bpWorker) {
                    this._bpWorker.postMessage(
                        { type: 'audioFrame', frame: e.data.frame, sampleRate: e.data.sampleRate },
                        [e.data.frame.buffer] // transfer
                    );
                }
            };

            // 5. Connect mic source → worklet (don't connect to destination)
            const source = this.audioCtx.createMediaStreamSource(this.stream);
            source.connect(this._bpWorkletNode);

            // 6. Tell the worker to load the model
            this._bpWorker.postMessage({ type: 'init' });

            return true;
        } catch (err) {
            console.error('[AudioManager] Basic Pitch init failed:', err);
            return false;
        }
    }

    /**
     * Stop the Basic Pitch pipeline only.
     */
    stopBasicPitch() {
        if (this._bpWorkletNode) {
            this._bpWorkletNode.port.postMessage({ type: 'stop' });
            this._bpWorkletNode.disconnect();
            this._bpWorkletNode = null;
        }
        if (this._bpWorker) {
            this._bpWorker.terminate();
            this._bpWorker = null;
        }
        this._bpReady = false;
    }

    /**
     * Stop microphone and clean up all pipelines.
     */
    stop() {
        this.active = false;
        this.stopBasicPitch();
        this.stopMidi();
        if (this.stream) {
            this.stream.getTracks().forEach(t => t.stop());
            this.stream = null;
        }
        if (this.audioCtx) {
            this.audioCtx.close();
            this.audioCtx = null;
        }
        this.workletNode = null;
    }
}
