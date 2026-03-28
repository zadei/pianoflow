/**
 * PianoFlow — main application entry point and state management.
 */
(function () {
    'use strict';

    // --- DOM Elements ---
    const uploadScreen = document.getElementById('upload-screen');
    const playerScreen = document.getElementById('player-screen');
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const browseBtn = document.getElementById('browse-btn');
    const uploadStatus = document.getElementById('upload-status');
    const statusText = document.getElementById('status-text');
    const uploadError = document.getElementById('upload-error');
    const errorText = document.getElementById('error-text');
    const retryBtn = document.getElementById('retry-btn');
    const playBtn = document.getElementById('play-btn');
    const backBtn = document.getElementById('back-btn');
    const tempoSlider = document.getElementById('tempo-slider');
    const tempoDisplay = document.getElementById('tempo-display');
    const pauseModeCheckbox = document.getElementById('pause-mode');
    const practiceModeCheckbox = document.getElementById('practice-mode');
    const metronomeToggle = document.getElementById('metronome-toggle');
    const micBtn = document.getElementById('mic-btn');
    const listenBtn = document.getElementById('listen-btn');
    const streakCount = document.getElementById('streak-count');
    const canvas = document.getElementById('game-canvas');
    const scrubberBar = document.getElementById('scrubber-bar');
    const scrubberFill = document.getElementById('scrubber-fill');
    const scrubberHandle = document.getElementById('scrubber-handle');
    const librarySection = document.getElementById('library-section');
    const libraryList = document.getElementById('library-list');
    const loopControls = document.getElementById('loop-controls');
    const loopEnabledCheckbox = document.getElementById('loop-enabled');
    const loopRangeInputs = document.getElementById('loop-range-inputs');
    const loopStartBarInput = document.getElementById('loop-start-bar');
    const loopEndBarInput = document.getElementById('loop-end-bar');

    // --- State ---
    const state = {
        notes: null,
        tempoBPM: 120,
        tempoMultiplier: 1.0,
        timeSignature: '4/4',
        keySignature: 'C major',
        playing: false,
        pauseMode: false,
        pauseFrozen: false,
        currentBeat: -2, // start slightly before first note
        streak: 0,
        detectedMidi: -1,
        jobId: null,
        practiceMode: false,
        practiceTargetNotes: null,
        practiceHintTimer: 0,
        practiceExcludeNotes: null,
        accuracy: { hits: 0, misses: 0 },
        loopEnabled: false,
        loopStartBar: 1,
        loopEndBar: 4,
    };

    // --- Modules ---
    const renderer = new Renderer(canvas);
    const audioMgr = new AudioManager();
    const pitchDet = new PitchDetector();
    const synth = new SynthPlayer();
    let micActive = false;
    let listenActive = false;
    let prevPauseFrozen = false;

    // Timing window for note hits (in beats)
    const HIT_WINDOW_BEATS = 0.5;

    // --- Polyphonic Pitch Detection (Basic Pitch) ---
    // Stores the latest set of MIDI notes detected by the ML model.
    let detectedPolyNotes = [];

    // --- Web MIDI keyboard notes ---
    // Stores notes currently held on a connected MIDI keyboard.
    let midiKeyboardNotes = [];

    // --- Note Accumulator ---
    // Buffers detected notes over a short window so that YIN, Basic Pitch,
    // and MIDI results can combine across frames for reliable chord detection.
    const NOTE_ACCUMULATOR_MS = 120; // time window to accumulate notes
    const noteAccumulator = new Map(); // midi_number → timestamp of last detection

    /**
     * Called by the Basic Pitch pipeline whenever new polyphonic notes
     * are detected from the microphone.
     *
     * Handles three scenarios:
     *  - Practice mode: match detected notes against the frozen chord
     *  - Play mode: match each detected note against the score
     *  - Always: light up detected keys on the keyboard
     *
     * @param {number[]} midiNotes - array of currently active MIDI note numbers
     */
    function handleDetectedNotes(midiNotes) {
        detectedPolyNotes = midiNotes;
        if (!midiNotes || midiNotes.length === 0) return;

        // Light up every detected key on the keyboard
        for (const midi of midiNotes) {
            renderer.activateKey(midi, 1, 0.2);
        }

        if (!state.playing || !state.notes) return;

        // Practice mode: gameLoop handles all matching — just return here
        if (state.practiceMode && state.practiceTargetNotes && state.practiceTargetNotes.length > 0) {
            return;
        }

        // Normal play mode: match each detected note against the score
        for (const midi of midiNotes) {
            matchNotes(midi);
        }
    }

    // --- Upload Handling ---

    browseBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        if (fileInput.files.length > 0) handleFile(fileInput.files[0]);
    });

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]);
    });

    retryBtn.addEventListener('click', resetUpload);

    const demoBtn = document.getElementById('demo-btn');
    if (demoBtn) {
        demoBtn.addEventListener('click', async () => {
            uploadStatus.classList.remove('hidden');
            uploadError.classList.add('hidden');
            statusText.textContent = 'Loading demo...';
            try {
                const res = await fetch('/api/demo');
                if (!res.ok) throw new Error('Demo unavailable');
                const data = await res.json();
                state.notes = data.notes;
                state.tempoBPM = data.tempo_bpm || 120;
                state.timeSignature = data.time_signature || '4/4';
                state.keySignature = data.key_signature || 'C major';
                state.currentBeat = -2;
                state.streak = 0;
                state.playing = false;
                state.accuracy = { hits: 0, misses: 0 };
                renderer.setKeyRange(state.notes);
                updateTempoDisplay();
                switchToPlayer();
            } catch (err) {
                showError('Demo unavailable: ' + err.message);
            }
        });
    }

    async function handleFile(file) {
        uploadStatus.classList.remove('hidden');
        uploadError.classList.add('hidden');
        statusText.textContent = 'Uploading...';

        const formData = new FormData();
        formData.append('file', file);

        try {
            const res = await fetch('/api/upload', { method: 'POST', body: formData });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || 'Upload failed');
            }
            const data = await res.json();
            state.jobId = data.job_id;
            statusText.textContent = 'Processing sheet music...';
            pollStatus(data.job_id);
        } catch (err) {
            showError(err.message);
        }
    }

    async function pollStatus(jobId) {
        const maxAttempts = 240; // 2 minutes at 1s intervals
        for (let i = 0; i < maxAttempts; i++) {
            await sleep(1000);
            try {
                const res = await fetch(`/api/status/${jobId}`);
                const data = await res.json();

                if (data.status === 'processing') {
                    statusText.textContent = `Processing... (${i + 1}s)`;
                }
                if (data.status === 'completed') {
                    await loadNotes(jobId);
                    loadLibrary();
                    return;
                }
                if (data.status === 'failed') {
                    showError(data.error || 'Processing failed. For best results, upload a MusicXML file (.xml or .mxl) directly — no Java required.');
                    return;
                }
            } catch (err) {
                showError('Connection lost');
                return;
            }
        }
        showError('Processing timed out. The file may be too complex.');
    }

    async function loadNotes(jobId) {
        try {
            const res = await fetch(`/api/notes/${jobId}`);
            const data = await res.json();
            state.notes = data.notes;
            state.tempoBPM = data.tempo_bpm || 120;
            state.timeSignature = data.time_signature || '4/4';
            state.keySignature = data.key_signature || 'C major';
            state.currentBeat = -2;
            state.streak = 0;
            state.playing = false;
            state.accuracy = { hits: 0, misses: 0 };

            renderer.setKeyRange(state.notes);
            updateTempoDisplay();
            switchToPlayer();
        } catch (err) {
            showError('Failed to load note data');
        }
    }

    function showError(msg) {
        uploadStatus.classList.add('hidden');
        uploadError.classList.remove('hidden');
        errorText.textContent = msg;
    }

    function resetUpload() {
        uploadStatus.classList.add('hidden');
        uploadError.classList.add('hidden');
        fileInput.value = '';
    }

    function switchToPlayer() {
        uploadScreen.classList.remove('active');
        playerScreen.classList.add('active');
        uploadStatus.classList.add('hidden');
        resizeCanvas();
    }

    function switchToUpload() {
        playerScreen.classList.remove('active');
        uploadScreen.classList.add('active');
        state.playing = false;
        playBtn.innerHTML = '&#9654;';
        if (listenActive) {
            synth.stop();
            listenActive = false;
            listenBtn.classList.remove('active');
        }
        audioMgr.stopMetronome();
        metronomeToggle.checked = false;
        resetUpload();
    }

    // --- Player Controls ---

    playBtn.addEventListener('click', () => {
        // Stop listen mode if active
        if (listenActive) {
            synth.stop();
            listenActive = false;
            listenBtn.classList.remove('active');
        }
        if (!state.playing && state.notes) {
            // If the song has ended, auto-reset to the beginning
            const total = getTotalBeats();
            if (state.currentBeat >= total - 0.5) {
                state.currentBeat = -2;
                state.notes.forEach(n => { n._hit = false; n._missed = false; n._playActivated = false; });
                state.streak = 0;
                state.accuracy = { hits: 0, misses: 0 };
            }
        }
        state.playing = !state.playing;
        playBtn.innerHTML = state.playing ? '&#10074;&#10074;' : '&#9654;';
    });

    listenBtn.addEventListener('click', () => {
        if (!state.notes) return;

        if (listenActive) {
            // Stop listen
            synth.stop();
            listenActive = false;
            listenBtn.classList.remove('active');
            state.playing = false;
            playBtn.innerHTML = '&#9654;';
        } else {
            // Listen mode is incompatible with practice/pause modes — disable them
            if (state.practiceMode) {
                practiceModeCheckbox.checked = false;
                state.practiceMode = false;
                state.practiceTargetNotes = null;
                state.practiceHintTimer = 0;
                loopControls.style.display = 'none';
                loopEnabledCheckbox.checked = false;
                state.loopEnabled = false;
                loopRangeInputs.style.display = 'none';
            }
            if (state.pauseMode) {
                pauseModeCheckbox.checked = false;
                state.pauseMode = false;
            }
            state.pauseFrozen = false;
            prevPauseFrozen = false;

            // Reset to start
            state.currentBeat = -2;
            state.notes.forEach(n => { n._hit = false; n._missed = false; n._playActivated = false; });
            state.streak = 0;
            state.accuracy = { hits: 0, misses: 0 };
            state.playing = true;
            playBtn.innerHTML = '&#10074;&#10074;';
            listenActive = true;
            listenBtn.classList.add('active');

            // Start synth in sync with the visual (beat starts at -2, notes start at ~0)
            synth.play(state.notes, state.tempoBPM, state.tempoMultiplier, state.currentBeat, () => {
                listenActive = false;
                listenBtn.classList.remove('active');
                state.playing = false;
                playBtn.innerHTML = '&#9654;';
            });
        }
    });

    backBtn.addEventListener('click', switchToUpload);

    tempoSlider.addEventListener('input', () => {
        state.tempoMultiplier = parseFloat(tempoSlider.value);
        updateTempoDisplay();
        // Resync synth to new tempo if listen mode is active
        if (listenActive) {
            synth.stop();
            synth.play(state.notes, state.tempoBPM, state.tempoMultiplier, state.currentBeat, () => {
                listenActive = false;
                listenBtn.classList.remove('active');
                state.playing = false;
                playBtn.innerHTML = '&#9654;';
            });
        }
        if (metronomeToggle.checked) {
            audioMgr.startMetronome(state.tempoBPM, state.tempoMultiplier);
        }
    });

    function updateTempoDisplay() {
        const effectiveBPM = Math.round(state.tempoBPM * state.tempoMultiplier);
        tempoDisplay.textContent = `${state.tempoMultiplier.toFixed(2)}x (${effectiveBPM} BPM)`;
    }

    pauseModeCheckbox.addEventListener('change', () => {
        state.pauseMode = pauseModeCheckbox.checked;
        state.pauseFrozen = false;
        prevPauseFrozen = false;
        // Stop listen mode — it can't coexist with pause mode
        if (state.pauseMode && listenActive) {
            synth.stop();
            listenActive = false;
            listenBtn.classList.remove('active');
            state.playing = false;
            playBtn.innerHTML = '&#9654;';
        }
    });

    practiceModeCheckbox.addEventListener('change', () => {
        const enabling = practiceModeCheckbox.checked;
        state.practiceMode = enabling;
        state.practiceTargetNotes = null;
        state.practiceHintTimer = 0;
        state.pauseFrozen = false;
        prevPauseFrozen = false;

        // Stop listen mode — it can't coexist with practice mode
        if (listenActive) {
            synth.stop();
            listenActive = false;
            listenBtn.classList.remove('active');
            state.playing = false;
            playBtn.innerHTML = '&#9654;';
        }

        // Enabling practice mid-play would start freezing on already-passed notes;
        // reset to the beginning for a clean start instead.
        if (enabling && state.playing && state.notes) {
            state.playing = false;
            state.currentBeat = -2;
            state.notes.forEach(n => { n._hit = false; n._missed = false; n._playActivated = false; });
            state.streak = 0;
            state.accuracy = { hits: 0, misses: 0 };
            playBtn.innerHTML = '&#9654;';
        }

        loopControls.style.display = state.practiceMode ? '' : 'none';
        if (!state.practiceMode) {
            loopEnabledCheckbox.checked = false;
            state.loopEnabled = false;
            loopRangeInputs.style.display = 'none';
        }
    });

    loopEnabledCheckbox.addEventListener('change', () => {
        state.loopEnabled = loopEnabledCheckbox.checked;
        loopRangeInputs.style.display = state.loopEnabled ? 'flex' : 'none';
    });

    loopStartBarInput.addEventListener('input', () => {
        state.loopStartBar = Math.max(1, parseInt(loopStartBarInput.value) || 1);
    });

    loopEndBarInput.addEventListener('input', () => {
        state.loopEndBar = Math.max(state.loopStartBar, parseInt(loopEndBarInput.value) || 1);
    });

    metronomeToggle.addEventListener('change', () => {
        if (metronomeToggle.checked) {
            audioMgr.startMetronome(state.tempoBPM, state.tempoMultiplier);
        } else {
            audioMgr.stopMetronome();
        }
    });

    // --- Scrubber ---

    function getTotalBeats() {
        if (!state.notes || state.notes.length === 0) return 1;
        let max = 0;
        for (const n of state.notes) {
            const end = n.start_beat + n.duration_beats;
            if (end > max) max = end;
        }
        return max || 1;
    }

    function updateScrubberUI() {
        if (!scrubberBar) return;
        const total = getTotalBeats();
        const frac = Math.max(0, Math.min(1, state.currentBeat / total));
        const pct = (frac * 100).toFixed(2) + '%';
        if (scrubberFill) scrubberFill.style.width = pct;
        if (scrubberHandle) scrubberHandle.style.left = pct;
    }

    function seekTo(beat) {
        state.currentBeat = beat;
        if (state.notes) {
            // Reset ALL notes on seek — any note before/after the target needs a clean slate
            state.notes.forEach(n => {
                n._hit = false;
                n._missed = false;
                n._playActivated = false;
            });
        }
        if (listenActive) {
            synth.stop();
            listenActive = false;
            listenBtn.classList.remove('active');
        }
    }

    function scrubberFractionFromEvent(e) {
        const rect = scrubberBar.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    }

    let scrubberDragging = false;

    scrubberBar.addEventListener('mousedown', (e) => {
        scrubberDragging = true;
        const frac = scrubberFractionFromEvent(e);
        seekTo(frac * getTotalBeats());
        updateScrubberUI();
    });

    window.addEventListener('mousemove', (e) => {
        if (!scrubberDragging) return;
        const frac = scrubberFractionFromEvent(e);
        seekTo(frac * getTotalBeats());
        updateScrubberUI();
    });

    window.addEventListener('mouseup', () => { scrubberDragging = false; });

    scrubberBar.addEventListener('touchstart', (e) => {
        scrubberDragging = true;
        const frac = scrubberFractionFromEvent(e);
        seekTo(frac * getTotalBeats());
        updateScrubberUI();
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
        if (!scrubberDragging) return;
        const frac = scrubberFractionFromEvent(e);
        seekTo(frac * getTotalBeats());
        updateScrubberUI();
    }, { passive: true });

    window.addEventListener('touchend', () => { scrubberDragging = false; });

    micBtn.addEventListener('click', async () => {
        if (micActive) {
            audioMgr.stop();
            micActive = false;
            micBtn.classList.remove('active');
            state.detectedMidi = -1;
            detectedPolyNotes = [];
            midiKeyboardNotes = [];
            noteAccumulator.clear();
        } else {
            const ok = await audioMgr.init();
            if (ok) {
                // Monophonic YIN pipeline (existing)
                audioMgr.onPitch = (freq, rms) => pitchDet.update(freq, rms);

                // Polyphonic Basic Pitch pipeline
                audioMgr.onNotes = handleDetectedNotes;
                const bpOk = await audioMgr.initBasicPitch();
                if (!bpOk) {
                    console.warn('Basic Pitch unavailable, falling back to YIN only');
                }

                // Web MIDI keyboard — instant, perfect multi-note detection
                audioMgr.onMidiNotes = (notes) => {
                    midiKeyboardNotes = notes;
                    handleDetectedNotes(notes);
                };
                const midiOk = await audioMgr.initMidi();
                if (midiOk) {
                    console.log('[PianoFlow] MIDI keyboard connected — chord detection active');
                }

                micActive = true;
                micBtn.classList.add('active');
            } else {
                showError('Microphone access denied. Please allow microphone access and try again.');
                switchToUpload();
            }
        }
    });

    // --- Game Loop ---

    function getBeatsPerBar() {
        const ts = state.timeSignature || '4/4';
        const parts = ts.split('/');
        return parseInt(parts[0], 10) || 4;
    }

    let lastTime = 0;

    function gameLoop(timestamp) {
        const dt = lastTime ? (timestamp - lastTime) / 1000 : 0;
        lastTime = timestamp;

        // Always update detected MIDI so the keyboard lights up even when paused
        state.detectedMidi = pitchDet.getMidi();

        if (state.playing && state.notes) {
            const detectedMidi = state.detectedMidi;

            // Practice mode: freeze on each chord until all notes are hit
            if (state.practiceMode) {
                const chordNotes = getNextPracticeChord();
                if (chordNotes.length > 0 && state.currentBeat >= chordNotes[0].start_beat - 0.05) {
                    state.practiceTargetNotes = chordNotes;
                    state.pauseFrozen = true;
                    state.practiceHintTimer += dt;

                    // Build the set of currently detected notes:
                    // combine YIN monophonic + Basic Pitch polyphonic + MIDI keyboard
                    // + accumulated recent detections for reliable chord matching
                    const now = performance.now();
                    const allDetected = new Set(detectedPolyNotes);
                    if (detectedMidi >= 0) allDetected.add(detectedMidi);
                    for (const midi of midiKeyboardNotes) allDetected.add(midi);

                    // Add notes from the accumulator (recently detected within window)
                    for (const [midi, ts] of noteAccumulator) {
                        if (now - ts <= NOTE_ACCUMULATOR_MS) {
                            allDetected.add(midi);
                        } else {
                            noteAccumulator.delete(midi);
                        }
                    }
                    // Feed current detections into accumulator
                    for (const midi of allDetected) {
                        noteAccumulator.set(midi, now);
                    }

                    // Exclude notes held over from the previous chord (require re-press for same note)
                    if (state.practiceExcludeNotes) {
                        for (const midi of [...state.practiceExcludeNotes]) {
                            if (!allDetected.has(midi)) state.practiceExcludeNotes.delete(midi);
                        }
                        for (const midi of state.practiceExcludeNotes) allDetected.delete(midi);
                    }

                    // Check if any detected note matches an unhit chord note
                    for (const midi of allDetected) {
                        const matchedNote = chordNotes.find(n => !n._hit && midi === n.midi_number);
                        if (matchedNote) {
                            matchedNote._hit = true;
                            state.streak++;
                            state.accuracy.hits++;
                            renderer.triggerHit(matchedNote.midi_number, matchedNote.staff);
                            audioMgr.playCorrectNote(matchedNote.midi_number);
                        }
                    }

                    // Unfreeze only when every note in the chord has been hit
                    if (chordNotes.every(n => n._hit)) {
                        state.practiceHintTimer = 0;
                        noteAccumulator.clear();
                        state.practiceExcludeNotes = new Set(allDetected); // prevent held notes from auto-satisfying the next chord
                        // Snap immediately to the next chord
                        const upcoming = getNextPracticeChord();
                        if (upcoming.length > 0) {
                            state.currentBeat = upcoming[0].start_beat - 0.05;
                            state.practiceTargetNotes = upcoming;
                            state.pauseFrozen = true;
                        } else {
                            // No more chords — unfreeze and let song finish
                            state.practiceTargetNotes = null;
                            state.pauseFrozen = false;
                        }
                    }
                } else if (chordNotes.length > 0) {
                    // Next chord exists but we haven't reached it — snap to it
                    state.currentBeat = chordNotes[0].start_beat - 0.05;
                    state.pauseFrozen = true;
                } else {
                    state.practiceTargetNotes = null;
                    state.pauseFrozen = false;
                }
            } else if (state.pauseMode) {
                // Pause mode: freeze if next note isn't played
                const nextNote = getNextUnhitNote();
                if (nextNote && state.currentBeat >= nextNote.start_beat - HIT_WINDOW_BEATS) {
                    // Unfreeze if YIN, Basic Pitch, or MIDI keyboard detected the target note
                    const noteDetected = detectedMidi === nextNote.midi_number ||
                        detectedPolyNotes.includes(nextNote.midi_number) ||
                        midiKeyboardNotes.includes(nextNote.midi_number);
                    state.pauseFrozen = !noteDetected;
                } else {
                    state.pauseFrozen = false;
                }
            }

            // Sync synth playback with freeze state (practice/pause mode)
            if (listenActive) {
                if (state.pauseFrozen && !prevPauseFrozen) {
                    synth.stop();
                } else if (!state.pauseFrozen && prevPauseFrozen && state.notes) {
                    synth.play(state.notes, state.tempoBPM, state.tempoMultiplier, state.currentBeat, () => {
                        listenActive = false;
                        listenBtn.classList.remove('active');
                        state.playing = false;
                        playBtn.innerHTML = '&#9654;';
                    });
                }
            }
            prevPauseFrozen = state.pauseFrozen;

            // Advance beat if not frozen
            if (!state.pauseFrozen) {
                const beatsPerSecond = (state.tempoBPM * state.tempoMultiplier) / 60;
                state.currentBeat += beatsPerSecond * dt;
            }

            // Bar loop: if loop enabled in practice mode, wrap back to start bar
            if (state.practiceMode && state.loopEnabled) {
                const bpb = getBeatsPerBar();
                const loopStartBeat = (state.loopStartBar - 1) * bpb;
                const loopEndBeat = state.loopEndBar * bpb;
                if (state.currentBeat >= loopEndBeat) {
                    state.currentBeat = loopStartBeat;
                    state.notes.forEach(n => {
                        n._hit = false;
                        n._missed = false;
                        n._playActivated = false;
                    });
                    state.practiceTargetNotes = null;
                    state.practiceHintTimer = 0;
                    state.pauseFrozen = false;
                    prevPauseFrozen = false;
                    if (listenActive) {
                        synth.stop();
                        synth.play(state.notes, state.tempoBPM, state.tempoMultiplier, loopStartBeat, () => {
                            listenActive = false;
                            listenBtn.classList.remove('active');
                            state.playing = false;
                            playBtn.innerHTML = '&#9654;';
                        });
                    }
                }
            }

            // Note matching (skip in practice mode — handled above)
            if (!state.practiceMode) {
                matchNotes(detectedMidi);
                // Also match any polyphonic notes not already caught by YIN
                for (const midi of detectedPolyNotes) {
                    if (midi !== detectedMidi) matchNotes(midi);
                }
                // Also match MIDI keyboard notes
                for (const midi of midiKeyboardNotes) {
                    if (midi !== detectedMidi && !detectedPolyNotes.includes(midi)) {
                        matchNotes(midi);
                    }
                }
            }

            // Light up keys as notes arrive at the hit line
            highlightCurrentNotes();
        }

        renderer.render(state, dt);
        streakCount.textContent = state.streak;

        const total = state.accuracy.hits + state.accuracy.misses;
        const accEl = document.getElementById('accuracy-display');
        if (accEl) accEl.textContent = total > 0 ? Math.round((state.accuracy.hits / total) * 100) + '%' : '--%';

        updateScrubberUI();

        requestAnimationFrame(gameLoop);
    }

    function getNextUnhitNote() {
        if (!state.notes) return null;
        for (const n of state.notes) {
            if (!n._hit && !n._missed && n.start_beat >= state.currentBeat - HIT_WINDOW_BEATS) {
                // Only block on treble (staff=1) notes when mic is active;
                // bass notes (staff=2) cannot be reliably detected via pitch detection.
                if (micActive && n.staff === 2) continue;
                return n;
            }
        }
        return null;
    }

    function getNextPracticeChord() {
        if (!state.notes) return [];
        // Find the first unhit note (skipping bass when mic is active)
        let firstNote = null;
        for (const n of state.notes) {
            if (!n._hit && !n._missed) {
                if (micActive && n.staff === 2) continue;
                firstNote = n;
                break;
            }
        }
        if (!firstNote) return [];
        // Return all unhit notes sharing the same start_beat (i.e. the full chord)
        const beat = firstNote.start_beat;
        return state.notes.filter(n =>
            !n._hit && !n._missed &&
            n.start_beat === beat &&
            !(micActive && n.staff === 2)
        );
    }

    function highlightCurrentNotes() {
        if (!state.notes) return;
        const beatsPerSec = (state.tempoBPM * state.tempoMultiplier) / 60;
        for (const note of state.notes) {
            if (note._playActivated) continue;
            if (state.currentBeat >= note.start_beat) {
                const durationSec = note.duration_beats / beatsPerSec;
                renderer.activateKey(note.midi_number, note.staff, durationSec);
                note._playActivated = true;
            }
        }
    }

    function matchNotes(detectedMidi) {
        if (!state.notes || detectedMidi < 0) return;

        for (const note of state.notes) {
            if (note._hit || note._missed) continue;

            const beatDiff = note.start_beat - state.currentBeat;

            // Within hit window?
            if (Math.abs(beatDiff) <= HIT_WINDOW_BEATS) {
                if (detectedMidi === note.midi_number) {
                    note._hit = true;
                    state.streak++;
                    state.accuracy.hits++;
                    renderer.triggerHit(note.midi_number, note.staff);
                    audioMgr.playCorrectNote(note.midi_number);
                }
            }

            // Passed and missed?
            // Skip miss-marking bass notes (staff=2) when using mic — they are not mic-playable.
            if (beatDiff < -HIT_WINDOW_BEATS && !note._hit) {
                if (micActive && note.staff === 2) {
                    note._missed = true; // mark so it doesn't loop forever, but don't penalise
                } else {
                    note._missed = true;
                    state.streak = 0;
                    state.accuracy.misses++;
                    if (state.practiceMode) audioMgr.playWrongNote();
                }
            }
        }
    }

    // --- Canvas Resize ---

    function resizeCanvas() {
        canvas.style.width = '100%';
        canvas.style.height = (playerScreen.clientHeight - 48) + 'px';
        renderer._resize();
    }

    window.addEventListener('resize', resizeCanvas);

    // --- Utilities ---

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // --- Library ---

    async function loadLibrary() {
        try {
            const res = await fetch('/api/library');
            const entries = await res.json();
            renderLibrary(entries);
        } catch (_) { /* library unavailable, stay hidden */ }
    }

    function renderLibrary(entries) {
        if (!entries || entries.length === 0) return;
        libraryList.innerHTML = '';
        entries.forEach(entry => {
            const li = document.createElement('li');
            li.className = 'library-item';
            const date = new Date(entry.saved_at).toLocaleDateString();
            li.innerHTML = `
                <div class="library-item-info">
                    <div class="library-item-name">${escapeHtml(entry.filename)}</div>
                    <div class="library-item-meta">${entry.note_count} notes &middot; ${entry.tempo_bpm} BPM &middot; ${date}</div>
                </div>
                <button class="library-item-delete" title="Remove" data-id="${entry.id}">&times;</button>
            `;
            li.addEventListener('click', (e) => {
                if (e.target.closest('.library-item-delete')) return;
                loadFromLibrary(entry.id);
            });
            li.querySelector('.library-item-delete').addEventListener('click', async (e) => {
                e.stopPropagation();
                await fetch(`/api/library/${entry.id}`, { method: 'DELETE' });
                li.remove();
                if (libraryList.children.length === 0) librarySection.classList.add('hidden');
            });
            libraryList.appendChild(li);
        });
        librarySection.classList.remove('hidden');
    }

    async function loadFromLibrary(entryId) {
        try {
            const res = await fetch(`/api/library/${entryId}`);
            const data = await res.json();
            state.notes = data.notes;
            state.tempoBPM = data.tempo_bpm || 120;
            state.timeSignature = data.time_signature || '4/4';
            state.keySignature = data.key_signature || 'C major';
            state.currentBeat = -2;
            state.streak = 0;
            state.playing = false;
            state.accuracy = { hits: 0, misses: 0 };
            renderer.setKeyRange(state.notes);
            updateTempoDisplay();
            switchToPlayer();
        } catch (err) {
            showError('Failed to load piece from library');
        }
    }

    function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // --- Start ---
    loadLibrary();
    requestAnimationFrame(gameLoop);
})();
