/**
 * A soft ringback tone while a call connects, generated with the Web Audio
 * API: no audio file to ship or cache.
 *
 * Two sine tones (440 Hz + 480 Hz, the North American ringback pair) at a
 * low volume, on for 1.2 s and off for 2.4 s, with short fades so the start
 * and end don't click. It must be started from a click handler: browsers only
 * allow audio to begin in response to a user gesture.
 */
export type Ringback = { stop: () => void };

const ON_S = 1.2;
const OFF_S = 2.4;
const VOLUME = 0.06;
const FADE_S = 0.04;

export function startRingback(): Ringback {
  const Ctx = typeof window !== "undefined" ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined;
  if (!Ctx) return { stop: () => {} };

  const ctx = new Ctx();
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(ctx.destination);
  const oscillators = [440, 480].map((hz) => {
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = hz;
    o.connect(gain);
    o.start();
    return o;
  });

  // Schedule rings a little ahead of time; refill the schedule as it runs down.
  let scheduledUntil = ctx.currentTime + 0.05;
  const schedule = () => {
    while (scheduledUntil < ctx.currentTime + 8) {
      const t = scheduledUntil;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(VOLUME, t + FADE_S);
      gain.gain.setValueAtTime(VOLUME, t + ON_S - FADE_S);
      gain.gain.linearRampToValueAtTime(0, t + ON_S);
      scheduledUntil = t + ON_S + OFF_S;
    }
  };
  schedule();
  const timer = setInterval(schedule, 2000);

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + FADE_S);
      setTimeout(() => {
        oscillators.forEach((o) => o.stop());
        void ctx.close();
      }, 100);
    },
  };
}
