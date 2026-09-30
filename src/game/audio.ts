import type { GameEvent } from './types';

// Short synthesized sounds keep the game self-contained and avoid asset downloads.
export class GameAudio {
  muted = false;
  private context?: AudioContext;
  private noise?: AudioBuffer;

  unlock(): void {
    if (!this.context) {
      this.context = new AudioContext();
      this.noise = this.context.createBuffer(
        1,
        this.context.sampleRate * 0.15,
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
      if (event.type === 'shot') this.shot(context);
      if (event.type === 'hit' && event.killed) this.tone(context, 190, 75, 0.09, 0.055);
      if (event.type === 'hurt') this.tone(context, 105, 48, 0.2, 0.12);
      if (event.type === 'over') this.tone(context, 160, 28, 0.7, 0.13);
    }
  }

  private tone(
    context: AudioContext,
    start: number,
    end: number,
    length: number,
    volume: number,
  ): void {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
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

  private shot(context: AudioContext): void {
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    const now = context.currentTime;
    source.buffer = this.noise!;
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2600, now);
    filter.frequency.exponentialRampToValueAtTime(300, now + 0.1);
    gain.gain.setValueAtTime(0.16, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    source.connect(filter).connect(gain).connect(context.destination);
    source.start(now);
    source.stop(now + 0.13);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
    this.tone(context, 150, 45, 0.11, 0.14);
  }
}
