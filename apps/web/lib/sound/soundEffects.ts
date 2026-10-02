/**
 * High-performance, zero-asset Web Audio API acoustic synthesizer & haptics engine.
 * 
 * Provides instant, crisp tactile audio feedback with 0KB downloaded assets,
 * zero latency, and native mobile vibration support.
 */

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!audioCtx) {
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  } catch {
    return null;
  }
}

export function isSoundEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const val = localStorage.getItem('sound_effects_enabled');
    return val !== 'false';
  } catch {
    return true;
  }
}

export function setSoundEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem('sound_effects_enabled', enabled ? 'true' : 'false');
  } catch {}
}

/**
 * Native mobile haptic feedback.
 */
export function triggerHaptic(type: 'light' | 'medium' | 'success' | 'pop' | 'tick' = 'light'): void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || !navigator.vibrate) return;
  try {
    switch (type) {
      case 'light':
      case 'tick':
        navigator.vibrate(10);
        break;
      case 'pop':
        navigator.vibrate(15);
        break;
      case 'medium':
        navigator.vibrate(25);
        break;
      case 'success':
        navigator.vibrate([12, 40, 20]);
        break;
    }
  } catch {}
}

/**
 * Satisfying, bouncy modern send sound (gentle 120ms rising sine pop).
 */
export function playSendSound(): void {
  if (!isSoundEnabled()) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    // Smooth pitch glide from 420Hz to 620Hz
    osc.frequency.setValueAtTime(420, now);
    osc.frequency.exponentialRampToValueAtTime(640, now + 0.08);

    // Exponential fade-out for clean pop
    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.13);
    triggerHaptic('light');
  } catch {}
}

/**
 * Cozy, friendly two-tone receive chime (520Hz -> 680Hz).
 */
export function playReceiveSound(): void {
  if (!isSoundEnabled()) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;

    // Tone 1
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(540, now);
    gain1.gain.setValueAtTime(0.07, now);
    gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.15);

    // Tone 2
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(720, now + 0.09);
    gain2.gain.setValueAtTime(0.07, now + 0.09);
    gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.09);
    osc2.stop(now + 0.25);

    triggerHaptic('pop');
  } catch {}
}

/**
 * Playful micro-bubble pop for emoji reactions, button clicks, or unlocks.
 */
export function playPopSound(): void {
  if (!isSoundEnabled()) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(780, now);
    osc.frequency.exponentialRampToValueAtTime(320, now + 0.05);

    gain.gain.setValueAtTime(0.09, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.07);
    triggerHaptic('tick');
  } catch {}
}

/**
 * Secret / View-Once unlock sound (clean crystalline chime).
 */
export function playUnlockSound(): void {
  if (!isSoundEnabled()) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    const freqs = [587.33, 880, 1174.66]; // D5, A5, D6
    freqs.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const startTime = now + idx * 0.04;
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, startTime);
      gain.gain.setValueAtTime(0.05, startTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.28);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startTime);
      osc.stop(startTime + 0.3);
    });
    triggerHaptic('success');
  } catch {}
}
