import type { GameEvent, WeaponId } from './types';

// Short synthesized sounds keep the game self-contained and avoid asset downloads.
export class GameAudio {
  muted = false;
  private context?: AudioContext;
  private noise?: AudioBuffer;
  private lastCoinSound = -Infinity;
  private lastDodgeSound = -Infinity;

  unlock(): void {
    if (!this.context) {
      this.context = new AudioContext();
      this.noise = this.context.createBuffer(
        1,
        this.context.sampleRate * 0.3,
        this.context.sampleRate,
      );
      const channel = this.noise.getChannelData(0);
      for (let i = 0; i < channel.length; i++) channel[i] = Math.random() * 2 - 1;
    }
    void this.context.resume();
  }

  play(events: GameEvent[]): void {
    const context = this.context;
    if (!context || this.muted || context.state !== 'running') return;
    for (const event of events) {
      if (event.type === 'shot') this.shot(context, event.weapon);
      if (event.type === 'hit' && event.killed) this.tone(context, 190, 75, 0.09, 0.055);
      if (event.type === 'reload') {
        this.noiseBurst(context, 0.045, 2200, 0.035);
        this.tone(context, 410, 140, 0.055, 0.025);
      }
      if (event.type === 'loaded') {
        this.noiseBurst(context, 0.035, event.weapon === 'shotgun' ? 1700 : 3200, 0.055);
        this.tone(context, event.weapon === 'shotgun' ? 470 : 620, 260, 0.045, 0.045);
      }
      if (event.type === 'grenadeThrown') {
        this.noiseBurst(context, 0.09, 1200, 0.06);
        this.tone(context, 720, 310, 0.08, 0.04);
      }
      if (event.type === 'explosion') {
        this.noiseBurst(context, 0.28, 2200, 0.24);
        this.tone(context, 85, 25, 0.5, 0.2);
      }
      if (event.type === 'dodge' && context.currentTime - this.lastDodgeSound > 0.1) {
        this.noiseBurst(context, 0.06, 4200, 0.035);
        this.lastDodgeSound = context.currentTime;
      }
      if (event.type === 'horde') {
        this.tone(context, 350, 175, 0.27, 0.075);
        this.tone(context, 350, 175, 0.27, 0.075, 0.32);
      }
      if (event.type === 'hurt') this.tone(context, 105, 48, 0.2, 0.12);
      if (event.type === 'over') this.tone(context, 160, 28, 0.7, 0.13);
      if (event.type === 'coins' && context.currentTime - this.lastCoinSound > 0.08) {
        this.tone(context, 880, 1174, 0.065, 0.03);
        this.lastCoinSound = context.currentTime;
      }
      if (event.type === 'bossWarning') {
        this.tone(context, 170, 245, 0.3, 0.09);
        this.tone(context, 170, 280, 0.3, 0.09, 0.4);
      }
      if (event.type === 'bossBreak') {
        this.noiseBurst(context, 0.18, 2100, 0.13);
        this.tone(context, 230, 55, 0.22, 0.1);
      }
      if (event.type === 'heal' || event.type === 'revive') {
        this.tone(context, 330, 660, 0.22, 0.07);
        if (event.type === 'revive') this.tone(context, 494, 988, 0.35, 0.07, 0.16);
      }
      if (event.type === 'clear') {
        this.tone(context, 392, 392, 0.18, 0.065);
        this.tone(context, 494, 494, 0.18, 0.065, 0.13);
        this.tone(context, event.final ? 784 : 587, event.final ? 784 : 587, 0.3, 0.065, 0.26);
      }
    }
  }

  private tone(
    context: AudioContext,
    start: number,
    end: number,
    length: number,
    volume: number,
    delay = 0,
  ): void {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime + delay;
    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(start, now);
    oscillator.frequency.exponentialRampToValueAtTime(end, now + length);
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + length);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + length);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  }

  private shot(context: AudioContext, weapon: WeaponId): void {
    if (weapon === 'sniper') {
      this.noiseBurst(context, 0.22, 1900, 0.2);
      this.tone(context, 110, 30, 0.23, 0.18);
      this.tone(context, 850, 230, 0.085, 0.035);
    } else if (weapon === 'shotgun') {
      this.noiseBurst(context, 0.17, 1600, 0.22);
      this.tone(context, 90, 30, 0.16, 0.18);
    } else {
      this.noiseBurst(context, 0.12, 2600, 0.16);
      this.tone(context, 150, 45, 0.11, 0.14);
    }
  }

  private noiseBurst(
    context: AudioContext,
    length: number,
    frequency: number,
    volume: number,
  ): void {
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    const now = context.currentTime;
    source.buffer = this.noise!;
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(frequency, now);
    filter.frequency.exponentialRampToValueAtTime(300, now + length);
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + length);
    source.connect(filter).connect(gain).connect(context.destination);
    source.start(now);
    source.stop(now + length + 0.01);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }
}
