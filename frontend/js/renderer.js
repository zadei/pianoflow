/**
 * Canvas renderer for falling notes, keyboard, and visual effects.
 */
class Renderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.particles = new ParticleSystem();

        // Layout constants
        this.KEYBOARD_HEIGHT_RATIO = 0.18;
        this.HIT_LINE_OFFSET = 0; // px above keyboard top
        this.NOTE_COLORS = {
            treble: '#d4a017', // gold
            bass: '#4a90d9',   // blue
        };
        this.HIT_GLOW_COLOR = '#ffe066';
        this.MISS_COLOR = '#884444';
        this.BG_COLOR = '#0a0a0f';

        // Practice mode animation state
        this._practiceRingTime = 0;

        // Hit ring animations: array of {x, y, time, maxTime}
        this._hitRings = [];

        // State
        this.keyRange = { low: 48, high: 72 }; // C3 to C5 default
        this.keyWidth = 0;
        this.blackKeyWidth = 0;
        this.keyboardTop = 0;
        this.hitLineY = 0;
        this.glowingKeys = new Map(); // midiNumber → {time, color}

        this._resize();
        window.addEventListener('resize', () => this._resize());
    }

    _resize() {
        this.canvas.width = this.canvas.clientWidth * devicePixelRatio;
        this.canvas.height = this.canvas.clientHeight * devicePixelRatio;
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.scale(devicePixelRatio, devicePixelRatio);
        this.w = this.canvas.clientWidth;
        this.h = this.canvas.clientHeight;
        this._recalcLayout();
    }

    _recalcLayout() {
        const kbH = this.h * this.KEYBOARD_HEIGHT_RATIO;
        this.keyboardTop = this.h - kbH;
        this.hitLineY = this.keyboardTop - this.HIT_LINE_OFFSET;

        // Count white keys in range
        this.whiteKeys = [];
        for (let m = this.keyRange.low; m <= this.keyRange.high; m++) {
            if (!this._isBlack(m)) this.whiteKeys.push(m);
        }
        this.keyWidth = this.whiteKeys.length > 0 ? this.w / this.whiteKeys.length : 30;
        this.blackKeyWidth = this.keyWidth * 0.6;
    }

    /**
     * Set the key range based on the note data.
     */
    setKeyRange(notes) {
        if (!notes || notes.length === 0) return;
        let low = 127, high = 0;
        for (const n of notes) {
            if (n.midi_number < low) low = n.midi_number;
            if (n.midi_number > high) high = n.midi_number;
        }
        // Pad by a few keys and snap to white keys
        low = Math.max(21, low - 4);
        high = Math.min(108, high + 4);
        // Snap down/up to nearest white key
        while (this._isBlack(low) && low > 21) low--;
        while (this._isBlack(high) && high < 108) high++;
        this.keyRange = { low, high };
        this._recalcLayout();
    }

    _isBlack(midi) {
        const n = midi % 12;
        return [1, 3, 6, 8, 10].includes(n);
    }

    /**
     * Get the x-center for a given MIDI note on the keyboard.
     */
    _noteX(midi) {
        if (this._isBlack(midi)) {
            // Position between the two adjacent white keys
            const lower = midi - 1;
            const upper = midi + 1;
            const lx = this._noteX(lower);
            const ux = this._noteX(upper);
            return (lx + ux) / 2;
        }
        const idx = this.whiteKeys.indexOf(midi);
        if (idx === -1) {
            // Out of range — estimate
            const ratio = (midi - this.keyRange.low) / (this.keyRange.high - this.keyRange.low);
            return ratio * this.w;
        }
        return (idx + 0.5) * this.keyWidth;
    }

    /**
     * Get the width for a note block.
     */
    _noteBlockWidth(midi) {
        return this._isBlack(midi) ? this.blackKeyWidth : this.keyWidth - 2;
    }

    /**
     * Main render call.
     * @param {object} state - { notes, currentBeat, tempoBPM, tempoMultiplier, playing, pauseMode, detectedMidi }
     * @param {number} dt - delta time in seconds
     */
    render(state, dt) {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.w, this.h);

        // Background with vignette
        this._drawBackground(ctx);

        // How many beats are visible in the fall zone
        const fallZoneHeight = this.hitLineY;
        const beatsVisible = 8; // show 8 beats of look-ahead

        this._drawFallingNotes(ctx, state, fallZoneHeight, beatsVisible);
        this._drawHitLine(ctx);
        this._drawKeyboard(ctx, state.detectedMidi);
        this._drawGlows(ctx, dt);
        this._drawHitRings(ctx, dt);
        this.particles.update(dt);
        this.particles.draw(ctx);

        // Practice mode overlay
        if (state.practiceMode && state.practiceTargetNotes && state.practiceTargetNotes.length > 0) {
            this._practiceRingTime += dt;
            this.drawPracticeHint(ctx, state.practiceTargetNotes);
        } else {
            this._practiceRingTime = 0;
        }
    }

    _drawBackground(ctx) {
        // Flat fill
        ctx.fillStyle = this.BG_COLOR;
        ctx.fillRect(0, 0, this.w, this.h);

        // Subtle radial vignette: slightly lighter at center, darker at edges
        const cx = this.w / 2;
        const cy = this.h / 2;
        const r = Math.sqrt(cx * cx + cy * cy);
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        grad.addColorStop(0, 'rgba(13,13,20,0)');    // center: transparent overlay
        grad.addColorStop(1, 'rgba(5,5,10,0.55)');   // edges: dark overlay
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, this.w, this.h);
    }

    _drawFallingNotes(ctx, state, fallZoneHeight, beatsVisible) {
        const { notes, currentBeat } = state;
        if (!notes) return;

        const pxPerBeat = fallZoneHeight / beatsVisible;

        for (const note of notes) {
            const beatOffset = note.start_beat - currentBeat;
            const noteEndBeat = note.start_beat + note.duration_beats - currentBeat;

            // Skip if entirely off-screen
            if (noteEndBeat < -1 || beatOffset > beatsVisible + 1) continue;

            const y = this.hitLineY - beatOffset * pxPerBeat;
            const yEnd = this.hitLineY - noteEndBeat * pxPerBeat;
            const blockHeight = Math.abs(y - yEnd);
            const x = this._noteX(note.midi_number);
            const w = this._noteBlockWidth(note.midi_number);

            // Determine color based on state
            let color;
            if (note._hit) {
                color = this.HIT_GLOW_COLOR;
            } else if (note._missed) {
                color = this.MISS_COLOR;
            } else {
                color = note.staff === 2 ? this.NOTE_COLORS.bass : this.NOTE_COLORS.treble;
            }

            // Draw note block with rounded corners and vertical gradient
            const radius = Math.min(4, blockHeight / 2, w / 2);
            const grad = ctx.createLinearGradient(x - w / 2, yEnd, x - w / 2, yEnd + blockHeight);
            grad.addColorStop(0, lightenColor(color, 0.3));
            grad.addColorStop(1, color);
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.roundRect(x - w / 2, yEnd, w, blockHeight, radius);
            ctx.fill();

            // Bright edge on hit
            if (note._hit) {
                ctx.save();
                ctx.shadowColor = this.HIT_GLOW_COLOR;
                ctx.shadowBlur = 15;
                ctx.fill();
                ctx.restore();
            }

            // Intersection glow: note touching keyboard
            if (y >= this.keyboardTop - 4) {
                ctx.save();
                ctx.globalAlpha = 0.45;
                const igGrad = ctx.createRadialGradient(x, this.keyboardTop, 0, x, this.keyboardTop, w * 1.4);
                igGrad.addColorStop(0, color);
                igGrad.addColorStop(1, 'transparent');
                ctx.fillStyle = igGrad;
                ctx.fillRect(x - w * 1.4, this.keyboardTop - w * 0.7, w * 2.8, w * 1.4);
                ctx.restore();
            }
        }
    }

    _drawHitLine(ctx) {
        ctx.strokeStyle = 'rgba(212, 160, 23, 0.4)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, this.hitLineY);
        ctx.lineTo(this.w, this.hitLineY);
        ctx.stroke();
    }

    _drawKeyboard(ctx, detectedMidi) {
        const kbH = this.h - this.keyboardTop;

        // White keys first
        for (let i = 0; i < this.whiteKeys.length; i++) {
            const midi = this.whiteKeys[i];
            const x = i * this.keyWidth;
            const glowData = this.glowingKeys.get(midi);
            const isActive = detectedMidi === midi || !!glowData;

            // Color-code by staff when active
            let activeColor = '#fffbe6'; // default: gold tint (treble)
            if (isActive && glowData) {
                activeColor = glowData.color === this.NOTE_COLORS.bass ? '#ddeeff' : '#fffbe6';
            }

            // Key body
            ctx.fillStyle = isActive ? activeColor : '#f0f0f0';
            ctx.fillRect(x, this.keyboardTop, this.keyWidth - 1, kbH);

            // Bottom shadow for 3D effect
            const grad = ctx.createLinearGradient(x, this.keyboardTop + kbH - 8, x, this.keyboardTop + kbH);
            grad.addColorStop(0, 'rgba(0,0,0,0)');
            grad.addColorStop(1, 'rgba(0,0,0,0.15)');
            ctx.fillStyle = grad;
            ctx.fillRect(x, this.keyboardTop, this.keyWidth - 1, kbH);

            // Border
            ctx.strokeStyle = '#bbb';
            ctx.lineWidth = 1;
            ctx.strokeRect(x, this.keyboardTop, this.keyWidth - 1, kbH);
        }

        // Black keys on top
        for (let m = this.keyRange.low; m <= this.keyRange.high; m++) {
            if (!this._isBlack(m)) continue;
            const x = this._noteX(m);
            const w = this.blackKeyWidth;
            const h = kbH * 0.6;
            const isActive = detectedMidi === m || this.glowingKeys.has(m);

            const blackGlowData = this.glowingKeys.get(m);
            let blackActiveColor = '#d4a017'; // gold default
            if (isActive && blackGlowData) {
                blackActiveColor = blackGlowData.color === this.NOTE_COLORS.bass ? '#4a90d9' : '#d4a017';
            }
            ctx.fillStyle = isActive ? blackActiveColor : '#222';
            ctx.fillRect(x - w / 2, this.keyboardTop, w, h);

            // Highlight
            const grad = ctx.createLinearGradient(x - w / 2, this.keyboardTop, x - w / 2, this.keyboardTop + h);
            grad.addColorStop(0, 'rgba(255,255,255,0.08)');
            grad.addColorStop(1, 'rgba(0,0,0,0.2)');
            ctx.fillStyle = grad;
            ctx.fillRect(x - w / 2, this.keyboardTop, w, h);
        }
    }

    _drawGlows(ctx, dt) {
        for (const [midi, glow] of this.glowingKeys) {
            glow.time -= dt;
            if (glow.time <= 0) {
                this.glowingKeys.delete(midi);
                continue;
            }
            const x = this._noteX(midi);
            const alpha = glow.time / glow.maxTime;
            ctx.save();
            ctx.globalAlpha = alpha * 0.6;
            const grad = ctx.createRadialGradient(x, this.hitLineY, 0, x, this.hitLineY, 40);
            grad.addColorStop(0, glow.color);
            grad.addColorStop(1, 'transparent');
            ctx.fillStyle = grad;
            ctx.fillRect(x - 50, this.hitLineY - 50, 100, 100);
            ctx.restore();
        }
    }

    _drawHitRings(ctx, dt) {
        for (let i = this._hitRings.length - 1; i >= 0; i--) {
            const ring = this._hitRings[i];
            ring.time -= dt;
            if (ring.time <= 0) {
                this._hitRings.splice(i, 1);
                continue;
            }
            const progress = 1 - ring.time / ring.maxTime;
            const radius = 10 + progress * 40;
            const alpha = ring.time / ring.maxTime;
            ctx.save();
            ctx.globalAlpha = alpha * 0.7;
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(ring.x, ring.y, radius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }
    }

    /**
     * Draw practice mode hint: note names + pulsing rings for all chord notes.
     * @param {Array} notes - array of NoteEvent objects (the current chord)
     */
    drawPracticeHint(ctx, notes) {
        const noteToMidi = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
        const pulse = (Math.sin(this._practiceRingTime * 5) + 1) / 2;
        const ringR = 18 + pulse * 8;
        const ringAlpha = 0.5 + pulse * 0.4;

        const xs = [];

        for (const note of notes) {
            // Skip already-hit notes (grey them out visually)
            const alreadyHit = note._hit;
            const match = note.pitch.match(/^([A-G])(#|b)?(\d+)$/);
            if (!match) continue;
            const base = noteToMidi[match[1]] ?? 0;
            const acc = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0;
            const octave = parseInt(match[3], 10);
            const midi = (octave + 1) * 12 + base + acc;
            const x = this._noteX(midi);
            const noteColor = note.staff === 2 ? this.NOTE_COLORS.bass : this.NOTE_COLORS.treble;
            xs.push({ x, pitch: note.pitch, alreadyHit, noteColor });

            // Pulsing ring around each key
            ctx.save();
            ctx.globalAlpha = alreadyHit ? 0.25 : ringAlpha;
            ctx.strokeStyle = alreadyHit ? '#4caf50' : noteColor;
            ctx.lineWidth = 3;
            ctx.shadowColor = alreadyHit ? '#4caf50' : noteColor;
            ctx.shadowBlur = 12;
            ctx.beginPath();
            ctx.arc(x, this.hitLineY + 12, ringR, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }

        // Label: show all note names joined, centered between the keys
        if (xs.length === 0) return;
        const labelX = xs.reduce((sum, e) => sum + e.x, 0) / xs.length;
        const label = xs.map(e => e.pitch).join(' + ');
        ctx.save();
        ctx.font = `bold ${xs.length > 1 ? '32' : '48'}px -apple-system, sans-serif`;
        // Use the color of the first unhit note, or first note if all hit
        const labelEntry = xs.find(e => !e.alreadyHit) || xs[0];
        ctx.fillStyle = labelEntry ? labelEntry.noteColor : '#d4a017';
        ctx.globalAlpha = 0.92;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.shadowColor = '#000';
        ctx.shadowBlur = 8;
        ctx.fillText(label, labelX, this.hitLineY - 18);
        ctx.restore();
    }

    /**
     * Trigger glow + particles for a correct hit.
     */
    triggerHit(midi, staff) {
        const x = this._noteX(midi);
        const color = staff === 2 ? this.NOTE_COLORS.bass : this.NOTE_COLORS.treble;
        this.glowingKeys.set(midi, { time: 0.4, maxTime: 0.4, color });
        this.particles.emit(x, this.hitLineY, color, 10);
        // Spawn a white ring expanding upward from the key
        this._hitRings.push({ x, y: this.hitLineY, time: 0.45, maxTime: 0.45 });
    }

    /**
     * Light up a key for playback (no particles).
     * Called when the beat reaches a note during play/listen.
     */
    activateKey(midi, staff, durationSec) {
        const color = staff === 2 ? this.NOTE_COLORS.bass : this.NOTE_COLORS.treble;
        const t = Math.max(0.15, durationSec);
        this.glowingKeys.set(midi, { time: t, maxTime: t, color });
    }
}

/**
 * Blend a hex color toward white by the given amount (0–1).
 */
function lightenColor(hex, amount) {
    // Parse 3- or 6-digit hex
    let r, g, b;
    const h = hex.replace('#', '');
    if (h.length === 3) {
        r = parseInt(h[0] + h[0], 16);
        g = parseInt(h[1] + h[1], 16);
        b = parseInt(h[2] + h[2], 16);
    } else {
        r = parseInt(h.slice(0, 2), 16);
        g = parseInt(h.slice(2, 4), 16);
        b = parseInt(h.slice(4, 6), 16);
    }
    r = Math.round(r + (255 - r) * amount);
    g = Math.round(g + (255 - g) * amount);
    b = Math.round(b + (255 - b) * amount);
    return `rgb(${r},${g},${b})`;
}
