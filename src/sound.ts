// High-Precision Web Audio Synthesizer for UIPM Ecoaims Target & Mechanical Pistol Trigger
class SoundFX {
  private ctx: AudioContext | null = null;
  public muted: boolean = false;

  private init() {
    if (this.muted) return;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  /**
   * Mechanical Cocking Lever Cycle (คันง้างไก/คันสับไก - Crisp Clack-Click)
   */
  playCockLever() {
    this.init();
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime;

    // First click: lever pulled back
    const osc1 = this.ctx.createOscillator();
    const g1 = this.ctx.createGain();
    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(1400, now);
    osc1.frequency.exponentialRampToValueAtTime(750, now + 0.025);
    g1.gain.setValueAtTime(0.25, now);
    g1.gain.exponentialRampToValueAtTime(0.005, now + 0.03);
    osc1.connect(g1);
    g1.connect(this.ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.032);

    // Second crisp snap: sear engages into battery
    const osc2 = this.ctx.createOscillator();
    const g2 = this.ctx.createGain();
    osc2.type = 'square';
    osc2.frequency.setValueAtTime(2200, now + 0.045);
    osc2.frequency.exponentialRampToValueAtTime(800, now + 0.075);
    g2.gain.setValueAtTime(0.28, now + 0.045);
    g2.gain.exponentialRampToValueAtTime(0.005, now + 0.08);
    osc2.connect(g2);
    g2.connect(this.ctx.destination);
    osc2.start(now + 0.045);
    osc2.stop(now + 0.082);
  }

  /**
   * Subtle mechanical click for Stage-1 trigger take-up (taking up slack to sear wall)
   */
  playTakeUp() {
    this.init();
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1900, now);
    osc.frequency.exponentialRampToValueAtTime(600, now + 0.015);

    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.015);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.016);
  }

  /**
   * Crisp mechanical dry-fire sear release + laser pulse click
   */
  playShot() {
    this.init();
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(2600, now);
    osc.frequency.exponentialRampToValueAtTime(240, now + 0.032);

    gain.gain.setValueAtTime(0.28, now);
    gain.gain.exponentialRampToValueAtTime(0.005, now + 0.032);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.035);
  }

  /**
   * Ecoaims LT600 Electronic Target Hit Beep (>= 7.0 ring)
   */
  playHit() {
    this.init();
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(1864.66, now); // A#6 crisp target beep
    osc.frequency.setValueAtTime(2349.32, now + 0.045); // D7 harmonic

    gain.gain.setValueAtTime(0.32, now);
    gain.gain.exponentialRampToValueAtTime(0.008, now + 0.16);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.17);
  }

  /**
   * 5th Hit Series Cleared Double-Beep
   */
  playSeriesCleared() {
    this.init();
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime;
    [0, 0.12].forEach((offset, idx) => {
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(idx === 0 ? 1975.5 : 2637.0, now + offset);
      gain.gain.setValueAtTime(0.35, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.008, now + offset + 0.11);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.12);
    });
  }

  /**
   * Trigger Jerk / Miss Low Buzz
   */
  playJerk() {
    this.init();
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'square';
    osc.frequency.setValueAtTime(145, now);
    osc.frequency.linearRampToValueAtTime(95, now + 0.11);

    gain.gain.setValueAtTime(0.18, now);
    gain.gain.linearRampToValueAtTime(0.008, now + 0.11);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.12);
  }

  /**
   * Visceral Low-Frequency Heartbeat Thump (LUB-DUB) during high HR / Apnea
   */
  playHeartbeat(intensity01: number = 0.5) {
    this.init();
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime;
    const vol = Math.min(0.28, 0.06 + intensity01 * 0.18);

    // LUB
    const osc1 = this.ctx.createOscillator();
    const g1 = this.ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(62, now);
    osc1.frequency.exponentialRampToValueAtTime(34, now + 0.07);
    g1.gain.setValueAtTime(vol, now);
    g1.gain.exponentialRampToValueAtTime(0.002, now + 0.075);
    osc1.connect(g1);
    g1.connect(this.ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.08);

    // DUB
    const osc2 = this.ctx.createOscillator();
    const g2 = this.ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(52, now + 0.11);
    osc2.frequency.exponentialRampToValueAtTime(30, now + 0.17);
    g2.gain.setValueAtTime(vol * 0.7, now + 0.11);
    g2.gain.exponentialRampToValueAtTime(0.002, now + 0.175);
    osc2.connect(g2);
    g2.connect(this.ctx.destination);
    osc2.start(now + 0.11);
    osc2.stop(now + 0.18);
  }

  /**
   * Cadence Pacer Metronome Tick
   */
  playMetronomeTick() {
    this.init();
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1050, now);
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.002, now + 0.025);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.03);
  }
}

export const sfx = new SoundFX();
