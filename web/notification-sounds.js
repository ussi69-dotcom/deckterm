// Completion sound policy + Web Audio player. Sounds are synthesized in the
// browser, so notifications never depend on external audio files or requests.

const COMPLETION_SOUND_PATTERNS = Object.freeze({
  chime: Object.freeze([
    Object.freeze({ frequency: 523.25, delay: 0, duration: 0.16, gain: 0.12 }),
    Object.freeze({ frequency: 659.25, delay: 0.11, duration: 0.2, gain: 0.1 }),
    Object.freeze({
      frequency: 783.99,
      delay: 0.22,
      duration: 0.28,
      gain: 0.08,
    }),
  ]),
  ping: Object.freeze([
    Object.freeze({ frequency: 880, delay: 0, duration: 0.12, gain: 0.1 }),
    Object.freeze({ frequency: 1320, delay: 0.08, duration: 0.16, gain: 0.07 }),
  ]),
  bell: Object.freeze([
    Object.freeze({ frequency: 659.25, delay: 0, duration: 0.42, gain: 0.1 }),
    Object.freeze({ frequency: 1318.51, delay: 0, duration: 0.3, gain: 0.045 }),
  ]),
  pop: Object.freeze([
    Object.freeze({ frequency: 392, delay: 0, duration: 0.08, gain: 0.11 }),
    Object.freeze({
      frequency: 587.33,
      delay: 0.06,
      duration: 0.1,
      gain: 0.08,
    }),
  ]),
});

function shouldPlayCompletionSound(
  mode,
  { documentHidden = false, documentFocused = true } = {},
) {
  if (mode === "off") return false;
  if (mode === "always") return true;
  return mode === "unfocused" && (documentHidden || !documentFocused);
}

function createCompletionSoundPlayer({ windowRef } = {}) {
  const targetWindow =
    windowRef || (typeof window !== "undefined" ? window : null);
  let context = null;

  function getContext() {
    if (context) return context;
    const AudioContextCtor =
      targetWindow?.AudioContext || targetWindow?.webkitAudioContext;
    if (!AudioContextCtor) return null;
    try {
      context = new AudioContextCtor();
    } catch {
      context = null;
    }
    return context;
  }

  async function unlock() {
    const audioContext = getContext();
    if (!audioContext) return false;
    if (audioContext.state === "suspended") {
      try {
        await audioContext.resume();
      } catch {
        return false;
      }
    }
    return audioContext.state !== "closed";
  }

  async function play(soundName = "chime") {
    const audioContext = getContext();
    if (!audioContext || !(await unlock())) return false;
    const pattern =
      COMPLETION_SOUND_PATTERNS[soundName] || COMPLETION_SOUND_PATTERNS.chime;
    const startAt = audioContext.currentTime + 0.015;

    try {
      for (const note of pattern) {
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        const noteStart = startAt + note.delay;
        const noteEnd = noteStart + note.duration;
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(note.frequency, noteStart);
        gain.gain.setValueAtTime(0.0001, noteStart);
        gain.gain.exponentialRampToValueAtTime(note.gain, noteStart + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start(noteStart);
        oscillator.stop(noteEnd + 0.02);
      }
      return true;
    } catch {
      return false;
    }
  }

  return { play, unlock };
}

const NotificationSounds = {
  COMPLETION_SOUND_PATTERNS,
  shouldPlayCompletionSound,
  createCompletionSoundPlayer,
};

if (typeof window !== "undefined")
  window.NotificationSounds = NotificationSounds;
if (typeof module !== "undefined" && module.exports) {
  module.exports = NotificationSounds;
}
