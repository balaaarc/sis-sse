import { BaseGenerator } from './base.js';
import { scenarioManager } from '../scenarioManager.js';
import type { GeneratorOpts, GenerateResult } from '../types.js';

type SeismicClass = 'HUMAN_FOOTFALL' | 'VEHICLE' | 'ANIMAL' | 'MACHINERY' | 'NOISE';

const CLASSIFICATIONS: SeismicClass[] = ['HUMAN_FOOTFALL', 'VEHICLE', 'ANIMAL', 'MACHINERY', 'NOISE'];

export class SeismicGenerator extends BaseGenerator {
  #waveformBuffer: number[] = new Array(100).fill(0);

  constructor(opts: GeneratorOpts) {
    super({ noiseSigma: 0.02, ...opts });
  }

  generate(): GenerateResult {
    const scenario = scenarioManager.getScenario();

    let pgvBase: number;
    let classification: SeismicClass;
    let confidence: number;
    let freqBase: number;

    switch (scenario) {
      case 'INTRUSION':
        pgvBase        = 2 + Math.random() * 6;
        classification = Math.random() < 0.7 ? 'HUMAN_FOOTFALL' : 'VEHICLE';
        confidence     = 0.75 + Math.random() * 0.25;
        freqBase       = 8 + Math.random() * 6;
        break;
      case 'TUNNEL_ACTIVITY':
        pgvBase        = 1 + Math.random() * 2;
        classification = 'MACHINERY';
        confidence     = 0.65 + Math.random() * 0.25;
        freqBase       = 20 + Math.random() * 30;
        break;
      case 'VEHICLE_CONVOY':
        pgvBase        = 3 + Math.random() * 5;
        classification = 'VEHICLE';
        confidence     = 0.80 + Math.random() * 0.20;
        freqBase       = 15 + Math.random() * 20;
        break;
      case 'DRONE':
        pgvBase        = 0.05 + Math.random() * 0.2;
        classification = Math.random() < 0.5 ? 'NOISE' : 'MACHINERY';
        confidence     = 0.35 + Math.random() * 0.3;
        freqBase       = 40 + Math.random() * 60;
        break;
      case 'ELEVATED':
        pgvBase        = 0.3 + Math.random() * 1.0;
        classification = CLASSIFICATIONS[Math.floor(Math.random() * CLASSIFICATIONS.length)];
        confidence     = 0.50 + Math.random() * 0.3;
        freqBase       = 10 + Math.random() * 20;
        break;
      default:
        pgvBase        = 0.01 + Math.random() * 0.08;
        classification = Math.random() < 0.6 ? 'NOISE' : 'ANIMAL';
        confidence     = 0.40 + Math.random() * 0.35;
        freqBase       = 2 + Math.random() * 8;
        break;
    }

    const pgv           = +(pgvBase + this.gaussian(pgvBase * 0.1)).toFixed(4);
    const rms           = +(pgv * (0.5 + Math.random() * 0.3)).toFixed(4);
    const dominant_freq = +(freqBase + this.gaussian(1)).toFixed(2);

    this.#waveformBuffer.shift();
    const newSample = pgv * Math.sin(2 * Math.PI * dominant_freq * (Date.now() / 1000)) + this.gaussian(pgv * 0.05);
    this.#waveformBuffer.push(+newSample.toFixed(5));

    const fft_magnitude = Array.from({ length: 64 }, (_, i) => {
      const freqBin = i * (100 / 64);
      const dist    = Math.abs(freqBin - dominant_freq);
      const peak    = Math.max(0, 20 - dist * 2) + this.gaussian(2);
      return +Math.max(-60, peak - 40 + this.gaussian(5)).toFixed(2);
    });

    const rawValue = {
      pgv,
      rms,
      dominant_freq,
      waveform:       [...this.#waveformBuffer],
      fft_magnitude,
      classification,
      confidence:     +confidence.toFixed(3),
    };

    const processed = confidence > 0.65
      ? {
          event_detected: true,
          classification,
          confidence:     +confidence.toFixed(3),
          alert_priority: pgv > 1.0 ? 'HIGH' : pgv > 0.3 ? 'MEDIUM' : 'LOW',
        }
      : { event_detected: false };

    return { rawValue, processed };
  }
}
