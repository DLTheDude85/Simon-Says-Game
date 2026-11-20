/* =====================================================================
   SIMON GAME
   ---------------------------------------------------------------------
   How a round works:
     1. The game adds ONE new random color to the end of the pattern.
     2. It plays the whole pattern back (lights + tones).
     3. The player repeats the pattern by clicking the pads in order.
     4. Correct -> next level (pattern grows by one, and may get faster).
        Wrong   -> replay the pattern (normal mode) or game over (strict mode).
     5. Finishing level MAX_LEVEL wins the game.
   Extras: sound tones (Web Audio), speed-up tiers, and best levels (one for
   normal mode, one for strict mode) saved in the browser (localStorage) so
   they are remembered next visit.
   ===================================================================== */

/* ---------- Settings (change these to tweak the game) ---------- */
const COLORS = ['green', 'red', 'yellow', 'blue']; // Must match the data-color values in index.html

// The level that wins the game. 31 matches the original Simon toy.
// Set to null for an endless game with no winning level.
const MAX_LEVEL = 31;

// Speed tiers: from `fromLevel` onward, the pattern plays with these timings.
//   stepMs  = time from the start of one color to the start of the next
//   lightMs = how long each pad stays lit (and how long its tone plays)
// The last tier is the fastest; levels past it stay at that speed.
const SPEED_TIERS = [
    { fromLevel: 1,  stepMs: 800, lightMs: 450 },
    { fromLevel: 5,  stepMs: 640, lightMs: 360 },
    { fromLevel: 9,  stepMs: 520, lightMs: 300 },
    { fromLevel: 13, stepMs: 420, lightMs: 240 }
];

const START_DELAY_MS = 700;       // Pause before a pattern starts playing
const CLICK_LIGHT_MS = 250;       // How long a pad stays lit when the player clicks it
const NEXT_LEVEL_DELAY_MS = 1000; // Pause after a correct pattern before the next level
const RETRY_DELAY_MS = 1200;      // Pause after a mistake before replaying (normal mode)

// Tone for each pad, in Hz. These are the notes used by the original Simon toy.
const TONES = { green: 415, red: 310, yellow: 252, blue: 209 };
const WRONG_TONE_HZ = 110;                      // Low buzz for a mistake
const WIN_TONES = [523, 659, 784, 1047];        // Rising notes (C, E, G, C) for winning

// Keys used to save things in the browser's localStorage.
// Normal mode and strict mode each keep their own best level, since strict mode is harder.
const BEST_KEYS = { normal: 'simon-best-normal', strict: 'simon-best-strict' };
const SOUND_KEY = 'simon-sound';

/* ---------- Page elements ---------- */
const board = document.getElementById('board');
const pads = Array.from(document.querySelectorAll('.pad')); // The four colored buttons
const levelDisplay = document.getElementById('current-level');
const bestLabel = document.getElementById('best-label');   // "Best level" / "Strict best level"
const bestDisplay = document.getElementById('best-level'); // The number
const bestText = document.getElementById('best');          // The whole line (gets highlighted for a new best)
const startButton = document.getElementById('start-button');
const strictButton = document.getElementById('strict-button');
const soundButton = document.getElementById('sound-button');
const statusText = document.getElementById('status');

/* =====================================================================
   Saved settings (localStorage)
   Wrapped in try/catch because some browsers block storage (for example
   private browsing). If saving fails, the game still works - it just
   won't remember anything next time.
   ===================================================================== */

function loadSetting(key) {
    try {
        return localStorage.getItem(key);
    } catch (error) {
        return null;
    }
}

function saveSetting(key, value) {
    try {
        localStorage.setItem(key, String(value));
    } catch (error) {
        /* Storage unavailable - ignore */
    }
}

/* ---------- Game state ---------- */
let sequence = [];          // The pattern the player must repeat, e.g. ['red', 'blue', 'red']
let playerIndex = 0;        // How many pads of the pattern the player has matched so far
let level = 0;              // Current level (also equals sequence.length)
let strictMode = false;     // true = one mistake ends the game
let acceptingInput = false; // true only while it is the player's turn
let timers = [];            // Every pending timeout, so we can cancel them all on restart

let gameActive = false;     // true from pressing Start until the game is won or lost

// Highest level reached in each mode (0 = none yet), loaded from the saved values
let bestLevels = {
    normal: parseInt(loadSetting(BEST_KEYS.normal), 10) || 0,
    strict: parseInt(loadSetting(BEST_KEYS.strict), 10) || 0
};
let beatBest = false;       // true if this game has set a new best level
let soundOn = loadSetting(SOUND_KEY) !== 'off';           // Sound is on unless the player turned it off

/* =====================================================================
   Small helpers
   ===================================================================== */

// Run a function after a delay, and remember the timer so it can be cancelled later.
function schedule(fn, delay) {
    timers.push(setTimeout(fn, delay));
}

// Cancel every pending timer. This prevents overlapping patterns if the
// player presses Restart while a pattern is still playing.
function clearTimers() {
    timers.forEach(clearTimeout);
    timers = [];
}

// Look up a pad element by its color name.
function getPad(color) {
    return pads.find(pad => pad.dataset.color === color);
}

// Show a message under the board.
// state: 'info' (neutral), 'good' (green text) or 'bad' (red text) - styled in style.css.
function setStatus(message, state = 'info') {
    statusText.textContent = message;
    statusText.dataset.state = state;
}

// Show the current level in the center of the board.
function updateLevelDisplay() {
    levelDisplay.textContent = level > 0 ? level : '–';
}

// Which mode is being played right now: 'normal' or 'strict'.
function getMode() {
    return strictMode ? 'strict' : 'normal';
}

// Show the best level for the current mode under the title ("–" if none yet).
function updateBestDisplay() {
    const best = bestLevels[getMode()];
    bestLabel.textContent = strictMode ? 'Strict best level' : 'Best level';
    bestDisplay.textContent = best > 0 ? best : '–';
    bestText.classList.toggle('new-best', beatBest); // Highlights it in gold while a new best is being set
}

// Enable or disable all four pads. Disabled pads can't be clicked,
// which stops the player from clicking while the pattern is playing.
function setPadsEnabled(enabled) {
    pads.forEach(pad => {
        pad.disabled = !enabled;
    });
    acceptingInput = enabled;
}

// Light a pad for a moment (and play its tone).
// The "lit" class (see style.css) makes it bright and glowing.
// withSound = false lights the pad silently (used for wrong clicks, which get a buzz instead).
function lightPad(color, duration, withSound = true) {
    const pad = getPad(color);
    pad.classList.add('lit');
    if (withSound) playTone(TONES[color], duration);
    schedule(() => pad.classList.remove('lit'), duration);
}

// Shake the board to signal a mistake.
function shakeBoard() {
    board.classList.remove('shake'); // Remove first so the animation can replay
    void board.offsetWidth;          // Forces the browser to register the removal
    board.classList.add('shake');
}

// Get the playback speed for a level (the last tier whose fromLevel has been reached).
function getSpeed(forLevel) {
    let speed = SPEED_TIERS[0];
    SPEED_TIERS.forEach(tier => {
        if (forLevel >= tier.fromLevel) speed = tier;
    });
    return speed;
}

/* =====================================================================
   Sound (Web Audio API)
   Tones are generated by the browser, so no audio files are needed.
   ===================================================================== */

let audioContext = null; // Created the first time it is needed

// Get the audio engine, creating it on first use. Browsers only allow audio after
// the player has interacted with the page, so this is first called from a click.
function getAudio() {
    if (!audioContext) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return null; // Very old browser: no sound support
        audioContext = new AudioContextClass();
    }
    // Phones may "suspend" audio until a tap; resume() wakes it up
    if (audioContext.state === 'suspended') audioContext.resume();
    return audioContext;
}

// Play one tone.
//   frequency  = pitch in Hz
//   durationMs = how long it lasts
//   type       = wave shape: 'sine' is smooth, 'sawtooth' is harsh (used for the buzz)
//   volume     = loudness from 0 to 1
//   delayMs    = wait before starting (used to space out the win notes)
function playTone(frequency, durationMs, type = 'sine', volume = 0.25, delayMs = 0) {
    if (!soundOn) return;
    const ctx = getAudio();
    if (!ctx) return;

    const start = ctx.currentTime + delayMs / 1000;
    const end = start + durationMs / 1000;

    const oscillator = ctx.createOscillator(); // Makes the raw tone
    const gain = ctx.createGain();             // Controls the volume over time

    oscillator.type = type;
    oscillator.frequency.value = frequency;

    // Fade in and out quickly so the tone doesn't "click" when it starts or stops
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.02);
    gain.gain.setValueAtTime(volume, end - 0.06);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    oscillator.connect(gain);
    gain.connect(ctx.destination); // ctx.destination = the speakers
    oscillator.start(start);
    oscillator.stop(end + 0.02);
}

// The low buzz played after a wrong pad.
function playWrongSound() {
    playTone(WRONG_TONE_HZ, 500, 'sawtooth', 0.18);
}

// The rising notes played when the player wins.
function playWinSound() {
    WIN_TONES.forEach((hz, i) => playTone(hz, 220, 'sine', 0.25, i * 160));
}

// Turn sound on or off and remember the choice.
function toggleSound() {
    soundOn = !soundOn;
    saveSetting(SOUND_KEY, soundOn ? 'on' : 'off');
    updateSoundButton();
    if (soundOn) getAudio(); // Wakes up audio now, from inside the tap
}

// Keep the sound switch's text and accessibility state in sync with soundOn.
function updateSoundButton() {
    soundButton.textContent = soundOn ? 'Sound: On' : 'Sound: Off';
    soundButton.setAttribute('aria-checked', String(soundOn));
}

/* =====================================================================
   Game flow
   ===================================================================== */

// Start (or restart) the game from level 1.
function startGame() {
    getAudio();                                     // Unlock audio during this tap (required on phones)
    clearTimers();                                  // Cancel anything still pending from a previous game
    pads.forEach(pad => pad.classList.remove('lit')); // Make sure no pad is stuck lit
    sequence = [];
    level = 0;
    gameActive = true;
    beatBest = false;
    updateBestDisplay();
    startButton.textContent = 'Restart';
    startButton.classList.remove('idle');           // Stop the idle pulse while a game is running
    nextLevel();
}

// Move to the next level: add one new color to the pattern, then play it.
function nextLevel() {
    level++;
    sequence.push(COLORS[Math.floor(Math.random() * COLORS.length)]); // Add ONE random color
    playerIndex = 0;
    updateLevelDisplay();

    // Save a new best level (for the current mode) the moment the player reaches it
    const mode = getMode();
    if (level > bestLevels[mode]) {
        bestLevels[mode] = level;
        beatBest = true;
        saveSetting(BEST_KEYS[mode], level);
        updateBestDisplay();
    }

    // Tell the player when this level is the first one at a faster speed
    const speedsUp = level > 1 && getSpeed(level) !== getSpeed(level - 1);
    playSequence(speedsUp);
}

// Play the whole pattern by lighting each pad in turn, then hand control to the player.
function playSequence(announceSpeedUp = false) {
    setPadsEnabled(false); // No clicking while the pattern plays
    playerIndex = 0;
    setStatus(announceSpeedUp ? 'Speeding up! Watch closely…' : 'Watch the pattern…');

    const speed = getSpeed(level); // Timings for the current level

    // Schedule each color to light up one after another
    sequence.forEach((color, i) => {
        schedule(() => lightPad(color, speed.lightMs), START_DELAY_MS + i * speed.stepMs);
    });

    // After the last color has finished, it is the player's turn
    const totalTime = START_DELAY_MS + (sequence.length - 1) * speed.stepMs + speed.lightMs;
    schedule(() => {
        setPadsEnabled(true);
        setStatus('Your turn.');
    }, totalTime + 200);
}

// Called whenever the player clicks a pad.
function handlePadClick(color) {
    if (!acceptingInput) return; // Ignore clicks outside the player's turn

    if (color === sequence[playerIndex]) {
        // Correct pad
        lightPad(color, CLICK_LIGHT_MS); // Instant light + tone as feedback
        playerIndex++;

        if (playerIndex === sequence.length) {
            // The player finished the whole pattern for this level
            setPadsEnabled(false);

            if (MAX_LEVEL !== null && level === MAX_LEVEL) {
                playWinSound();
                endGame(`You win! You completed all ${MAX_LEVEL} levels.`, 'good');
            } else {
                setStatus('Correct!', 'good');
                schedule(nextLevel, NEXT_LEVEL_DELAY_MS);
            }
        }
    } else {
        lightPad(color, CLICK_LIGHT_MS, false); // Light the wrong pad silently - the buzz plays instead
        handleMistake();
    }
}

// Called when the player clicks the wrong pad.
function handleMistake() {
    setPadsEnabled(false);
    shakeBoard();
    playWrongSound();

    if (strictMode) {
        // Strict mode: the game is over
        endGame(`Wrong pad. Game over at level ${level}.`, 'bad');
    } else {
        // Normal mode: replay the same pattern and let the player try again
        setStatus('Wrong pad. Watch the pattern again.', 'bad');
        schedule(playSequence, RETRY_DELAY_MS);
    }
}

// Finish the game (win or lose) and invite the player to play again.
function endGame(message, state) {
    gameActive = false;
    setPadsEnabled(false);
    setStatus(beatBest ? `${message} New best level!` : message, state);
    startButton.textContent = 'Play again';
    startButton.classList.add('idle'); // Bring the gentle pulse back on the button
}

// Turn strict mode on or off.
// Switching during a game starts a new game, so a level reached in one mode
// can never count toward the other mode's best level.
function toggleStrictMode() {
    strictMode = !strictMode;
    strictButton.textContent = strictMode ? 'Strict mode: On' : 'Strict mode: Off';
    strictButton.setAttribute('aria-checked', String(strictMode)); // Keeps screen readers in sync

    if (gameActive) {
        startGame(); // Begin a fresh game in the new mode (this also refreshes the best level shown)
    } else {
        beatBest = false;   // Clear any leftover "new best" highlight from the last game
        updateBestDisplay(); // Show the best level for the newly selected mode
    }
}

/* =====================================================================
   Setup and event listeners (these replace the old inline onclick attributes)
   ===================================================================== */

// Each pad reports its color when clicked
pads.forEach(pad => {
    pad.addEventListener('click', () => handlePadClick(pad.dataset.color));
});

startButton.addEventListener('click', startGame);
strictButton.addEventListener('click', toggleStrictMode);
soundButton.addEventListener('click', toggleSound);

// Remove the shake class when its animation finishes so it can be triggered again
board.addEventListener('animationend', () => board.classList.remove('shake'));

// Show the saved best level and sound setting as soon as the page loads
updateBestDisplay();
updateSoundButton();
