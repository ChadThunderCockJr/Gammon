let ctx: AudioContext | null = null;

const MUTE_KEY = "gammon-sound-muted";

export function isSoundMuted(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(MUTE_KEY) === "true";
}

export function setSoundMuted(muted: boolean): void {
  try { localStorage.setItem(MUTE_KEY, String(muted)); } catch {}
}

function getCtx(): AudioContext | null {
  if (isSoundMuted()) return null;
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

// Dice roll params
const DICE_FILTER_FREQ = 3500;
const DICE_FILTER_Q = 0.7;
const DICE_GAIN = 0.12;
const DICE_DURATION = 0.35;
const DICE_DECAY = 0.25;

// Checker place params
const PLACE_FREQ_START = 900;
const PLACE_FREQ_END = 400;
const PLACE_RAMP_TIME = 0.06;
const PLACE_GAIN_START = 0.1;
const PLACE_GAIN_END = 0.001;
const PLACE_DURATION = 0.08;

// Checker hit params
const HIT_FREQ_START = 300;
const HIT_FREQ_END = 150;
const HIT_RAMP_TIME = 0.12;
const HIT_GAIN_START = 0.18;
const HIT_GAIN_END = 0.001;
const HIT_DURATION = 0.15;
const HIT2_FREQ_START = 600;
const HIT2_FREQ_END = 200;
const HIT2_DELAY = 0.04;
const HIT2_RAMP_TIME = 0.1;
const HIT2_GAIN_START = 0.08;
const HIT2_GAIN_END = 0.001;
const HIT2_DURATION = 0.12;

// Turn end params
const TURN_END_FREQS = [660, 880];
const TURN_END_NOTE_GAP = 0.12;
const TURN_END_ATTACK = 0.02;
const TURN_END_GAIN = 0.06;
const TURN_END_DECAY = 0.25;

// Game over params
const WIN_NOTES = [523, 659, 784, 1047];
const LOSE_NOTES = [400, 350, 300, 250];
const GAMEOVER_NOTE_GAP = 0.15;
const GAMEOVER_ATTACK = 0.03;
const WIN_GAIN = 0.08;
const LOSE_GAIN = 0.05;
const GAMEOVER_DECAY = 0.4;

export function playDiceRoll() {
  try {
    const ac = getCtx();
    if (!ac) return;
    const bufferSize = Math.floor(ac.sampleRate * DICE_DURATION);
    const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * DICE_DECAY));
    }
    const source = ac.createBufferSource();
    source.buffer = buffer;
    const filter = ac.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = DICE_FILTER_FREQ;
    filter.Q.value = DICE_FILTER_Q;
    const gain = ac.createGain();
    gain.gain.value = DICE_GAIN;
    source.connect(filter).connect(gain).connect(ac.destination);
    source.start();
  } catch {}
}

export function playCheckerPlace() {
  try {
    const ac = getCtx();
    if (!ac) return;
    const t = ac.currentTime;
    const osc = ac.createOscillator();
    osc.frequency.setValueAtTime(PLACE_FREQ_START, t);
    osc.frequency.exponentialRampToValueAtTime(PLACE_FREQ_END, t + PLACE_RAMP_TIME);
    osc.type = "sine";
    const gain = ac.createGain();
    gain.gain.setValueAtTime(PLACE_GAIN_START, t);
    gain.gain.exponentialRampToValueAtTime(PLACE_GAIN_END, t + PLACE_DURATION);
    osc.connect(gain).connect(ac.destination);
    osc.start(t);
    osc.stop(t + PLACE_DURATION);
  } catch {}
}

export function playCheckerHit() {
  try {
    const ac = getCtx();
    if (!ac) return;
    const t = ac.currentTime;
    const osc = ac.createOscillator();
    osc.frequency.setValueAtTime(HIT_FREQ_START, t);
    osc.frequency.exponentialRampToValueAtTime(HIT_FREQ_END, t + HIT_RAMP_TIME);
    osc.type = "triangle";
    const gain = ac.createGain();
    gain.gain.setValueAtTime(HIT_GAIN_START, t);
    gain.gain.exponentialRampToValueAtTime(HIT_GAIN_END, t + HIT_DURATION);
    osc.connect(gain).connect(ac.destination);
    osc.start(t);
    osc.stop(t + HIT_DURATION);

    // Second click
    const osc2 = ac.createOscillator();
    osc2.frequency.setValueAtTime(HIT2_FREQ_START, t + HIT2_DELAY);
    osc2.frequency.exponentialRampToValueAtTime(HIT2_FREQ_END, t + HIT2_RAMP_TIME);
    osc2.type = "sine";
    const gain2 = ac.createGain();
    gain2.gain.setValueAtTime(HIT2_GAIN_START, t + HIT2_DELAY);
    gain2.gain.exponentialRampToValueAtTime(HIT2_GAIN_END, t + HIT2_DURATION);
    osc2.connect(gain2).connect(ac.destination);
    osc2.start(t + HIT2_DELAY);
    osc2.stop(t + HIT2_DURATION);
  } catch {}
}

export function playTurnEnd() {
  try {
    const ac = getCtx();
    if (!ac) return;
    const t = ac.currentTime;
    TURN_END_FREQS.forEach((freq, i) => {
      const osc = ac.createOscillator();
      osc.frequency.value = freq;
      osc.type = "sine";
      const gain = ac.createGain();
      const start = t + i * TURN_END_NOTE_GAP;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(TURN_END_GAIN, start + TURN_END_ATTACK);
      gain.gain.exponentialRampToValueAtTime(0.001, start + TURN_END_DECAY);
      osc.connect(gain).connect(ac.destination);
      osc.start(start);
      osc.stop(start + TURN_END_DECAY);
    });
  } catch {}
}

export function playGameOver(won: boolean) {
  try {
    const ac = getCtx();
    if (!ac) return;
    const t = ac.currentTime;
    const notes = won ? WIN_NOTES : LOSE_NOTES;
    notes.forEach((freq, i) => {
      const osc = ac.createOscillator();
      osc.frequency.value = freq;
      osc.type = won ? "sine" : "triangle";
      const gain = ac.createGain();
      const start = t + i * GAMEOVER_NOTE_GAP;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(won ? WIN_GAIN : LOSE_GAIN, start + GAMEOVER_ATTACK);
      gain.gain.exponentialRampToValueAtTime(0.001, start + GAMEOVER_DECAY);
      osc.connect(gain).connect(ac.destination);
      osc.start(start);
      osc.stop(start + GAMEOVER_DECAY);
    });
  } catch {}
}
