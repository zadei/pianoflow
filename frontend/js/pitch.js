/**
 * Pitch detection manager — maps frequencies to MIDI notes and manages matching.
 */
class PitchDetector {
    constructor() {
        this.currentFrequency = -1;
        this.currentMidi = -1;
        this.currentRms = 0;

        // A4 = 440Hz, MIDI 69
        this.A4 = 440;
        this.TOLERANCE_CENTS = 50; // +/- half semitone
    }

    /**
     * Update with a new frequency reading from the AudioWorklet.
     * @param {number} frequency - Hz, or -1 if no pitch
     * @param {number} rms - volume level
     */
    update(frequency, rms) {
        this.currentFrequency = frequency;
        this.currentRms = rms;

        if (frequency <= 0) {
            this.currentMidi = -1;
            return;
        }

        // Convert frequency to MIDI number
        const midiFloat = 69 + 12 * Math.log2(frequency / this.A4);
        const midiRounded = Math.round(midiFloat);
        const centsOff = Math.abs(midiFloat - midiRounded) * 100;

        if (centsOff <= this.TOLERANCE_CENTS && midiRounded >= 21 && midiRounded <= 108) {
            this.currentMidi = midiRounded;
        } else {
            this.currentMidi = -1;
        }
    }

    /**
     * Get the currently detected MIDI note number, or -1.
     */
    getMidi() {
        return this.currentMidi;
    }
}
