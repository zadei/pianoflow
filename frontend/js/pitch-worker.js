/**
 * Web Worker for @spotify/basic-pitch polyphonic pitch detection.
 *
 * Loads TensorFlow.js via CDN, then uses the Basic Pitch model to
 * extract polyphonic MIDI notes from streaming audio windows.
 *
 * Message protocol:
 *   IN:  { type: 'init' }                           → load tf + model
 *   IN:  { type: 'audioFrame', frame, sampleRate }   → run inference
 *   OUT: { type: 'ready' }                           → model loaded
 *   OUT: { type: 'notes', midiNotes: number[] }      → detected MIDI notes
 *   OUT: { type: 'error', message: string }          → error report
 */

/* global tf */

// --- Constants matching Basic Pitch internals ---
const BP_SAMPLE_RATE = 22050;
const FFT_HOP = 256;
const ANNOTATIONS_FPS = Math.floor(BP_SAMPLE_RATE / FFT_HOP);  // ~86
const AUDIO_WINDOW_LENGTH_SECONDS = 2;
const AUDIO_N_SAMPLES = BP_SAMPLE_RATE * AUDIO_WINDOW_LENGTH_SECONDS - FFT_HOP;
const N_OVERLAPPING_FRAMES = 30;
const N_OVERLAP_OVER_2 = Math.floor(N_OVERLAPPING_FRAMES / 2);
const OVERLAP_LENGTH_FRAMES = N_OVERLAPPING_FRAMES * FFT_HOP;
const HOP_SIZE = AUDIO_N_SAMPLES - OVERLAP_LENGTH_FRAMES;
const MIDI_OFFSET = 21;
const MAX_FREQ_IDX = 87;

const OUTPUT_NAMES = {
    contours: 'Identity',
    onsets: 'Identity_2',
    frames: 'Identity_1',
};

let model = null;
let modelReady = false;
let processing = false;

// --- Model loading ---

async function initModel() {
    try {
        // Load TensorFlow.js in the worker context
        importScripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.21.0/dist/tf.min.js');

        // Set the WASM or WebGL backend (WebGL preferred for speed)
        await tf.setBackend('webgl');
        await tf.ready();

        // Load the Basic Pitch model from our backend mount
        model = await tf.loadGraphModel('/model/model.json');

        modelReady = true;
        self.postMessage({ type: 'ready' });
    } catch (err) {
        self.postMessage({ type: 'error', message: 'Model init failed: ' + err.message });
    }
}

// --- Audio resampling ---

function resample(input, sourceSR, targetSR) {
    if (sourceSR === targetSR) return input;
    const ratio = sourceSR / targetSR;
    const outputLen = Math.round(input.length / ratio);
    const output = new Float32Array(outputLen);
    for (let i = 0; i < outputLen; i++) {
        const srcIdx = i * ratio;
        const lo = Math.floor(srcIdx);
        const hi = Math.min(lo + 1, input.length - 1);
        const frac = srcIdx - lo;
        output[i] = input[lo] * (1 - frac) + input[hi] * frac;
    }
    return output;
}

// --- Basic Pitch inference (mirrors inference.js) ---

function unwrapOutput(result) {
    const shape = result.shape; // [batches, frames, pitches]
    const sliced = result.slice(
        [0, N_OVERLAP_OVER_2, 0],
        [-1, shape[1] - 2 * N_OVERLAP_OVER_2, -1]
    );
    const s = sliced.shape;
    return sliced.reshape([s[0] * s[1], s[2]]);
}

async function runInference(audioData) {
    // Pad with zeros at the beginning (same as BasicPitch.prepareData)
    const padded = tf.concat1d([
        tf.zeros([Math.floor(OVERLAP_LENGTH_FRAMES / 2)], 'float32'),
        tf.tensor(audioData),
    ]);

    // Frame the audio into overlapping windows
    const framed = tf.expandDims(
        tf.signal.frame(padded, AUDIO_N_SAMPLES, HOP_SIZE, true, 0),
        -1
    );

    const nBatches = framed.shape[0];
    const nOutputFramesOriginal = Math.floor(
        audioData.length * (ANNOTATIONS_FPS / BP_SAMPLE_RATE)
    );

    // Collect tensors on the GPU across all batches, then do ONE GPU→CPU transfer
    // at the end. The previous pattern called .array() every iteration which
    // forced a synchronous GPU→CPU flush per batch — very expensive.
    const batchFrameTensors = [];
    const batchOnsetTensors = [];
    let calculatedFrames = 0;

    for (let i = 0; i < nBatches; i++) {
        const singleBatch = tf.slice(framed, i, 1);
        const results = model.execute(singleBatch, [
            OUTPUT_NAMES.frames,
            OUTPUT_NAMES.onsets,
            OUTPUT_NAMES.contours,
        ]);

        // Dispose contours immediately — we never use them for active-note extraction
        tf.dispose([singleBatch, results[2]]);

        let unwrappedFrames = unwrapOutput(results[0]);
        let unwrappedOnsets = unwrapOutput(results[1]);
        tf.dispose([results[0], results[1]]);

        const batchFrameCount = unwrappedFrames.shape[0];

        if (calculatedFrames >= nOutputFramesOriginal) {
            tf.dispose([unwrappedFrames, unwrappedOnsets]);
            continue;
        }

        if (batchFrameCount + calculatedFrames >= nOutputFramesOriginal) {
            const keep = nOutputFramesOriginal - calculatedFrames;
            const trimmedF = unwrappedFrames.slice([0, 0], [keep, -1]);
            const trimmedO = unwrappedOnsets.slice([0, 0], [keep, -1]);
            tf.dispose([unwrappedFrames, unwrappedOnsets]);
            unwrappedFrames = trimmedF;
            unwrappedOnsets = trimmedO;
        }

        calculatedFrames += batchFrameCount;
        batchFrameTensors.push(unwrappedFrames);
        batchOnsetTensors.push(unwrappedOnsets);
    }

    tf.dispose([padded, framed]);

    // Single GPU→CPU transfer for the entire output
    let frames, onsets;
    if (batchFrameTensors.length === 0) {
        frames = [];
        onsets = [];
    } else if (batchFrameTensors.length === 1) {
        frames = await batchFrameTensors[0].array();
        onsets = await batchOnsetTensors[0].array();
        tf.dispose([batchFrameTensors[0], batchOnsetTensors[0]]);
    } else {
        const concatF = tf.concat(batchFrameTensors, 0);
        const concatO = tf.concat(batchOnsetTensors, 0);
        tf.dispose([...batchFrameTensors, ...batchOnsetTensors]);
        frames = await concatF.array();
        onsets = await concatO.array();
        tf.dispose([concatF, concatO]);
    }

    return { frames, onsets };
}

// --- Note extraction (simplified outputToNotesPoly) ---

function extractActiveNotes(frames, onsets, onsetThresh, frameThresh) {
    if (frames.length === 0) return [];

    const nFrames = frames.length;
    const nPitches = frames[0].length;

    // Find pitches that are currently active in the LAST portion of the window
    // (most recent audio). We check the last ~0.25 seconds of frames.
    const recentFrameCount = Math.min(
        Math.floor(ANNOTATIONS_FPS * 0.3),
        nFrames
    );
    const startIdx = nFrames - recentFrameCount;

    const activeMidi = new Set();

    for (let f = startIdx; f < nFrames; f++) {
        for (let p = 0; p < nPitches; p++) {
            // A note is "active" if its frame activation is above threshold
            if (frames[f][p] > frameThresh) {
                activeMidi.add(p + MIDI_OFFSET);
            }
        }
    }

    // Also check for onsets in the recent window for newly struck notes
    for (let f = startIdx; f < nFrames; f++) {
        for (let p = 0; p < nPitches; p++) {
            if (onsets[f][p] > onsetThresh) {
                activeMidi.add(p + MIDI_OFFSET);
            }
        }
    }

    return Array.from(activeMidi).sort((a, b) => a - b);
}

// --- Frame processing ---

async function processFrame(frame, frameSampleRate) {
    if (!modelReady || !model || processing) return;

    processing = true;
    try {
        // Resample to 22050 Hz
        const resampled = resample(frame, frameSampleRate, BP_SAMPLE_RATE);

        // Run the model
        const { frames, onsets } = await runInference(resampled);

        // Extract currently active MIDI notes
        const midiNotes = extractActiveNotes(frames, onsets, 0.5, 0.3);

        self.postMessage({ type: 'notes', midiNotes });
    } catch (err) {
        self.postMessage({ type: 'error', message: 'Inference failed: ' + err.message });
    } finally {
        processing = false;
    }
}

// --- Message handler ---

self.onmessage = (e) => {
    switch (e.data.type) {
        case 'init':
            initModel();
            break;
        case 'audioFrame':
            processFrame(e.data.frame, e.data.sampleRate);
            break;
    }
};
