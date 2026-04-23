import { BaseGenerator } from './base.js';
import { scenarioManager } from '../scenarioManager.js';
import type { GeneratorOpts, GenerateResult } from '../types.js';

type AcousticClass = 'GUNSHOT' | 'VEHICLE' | 'HUMAN_VOICE' | 'ANIMAL' | 'MACHINERY' | 'EXPLOSION' | 'AMBIENT';

export class AcousticGenerator extends BaseGenerator {
  constructor(opts: GeneratorOpts) {
    super({ noiseSigma: 0.03, ...opts });
  }

  #melSpectrogram(peakBin: number, peakAmplitude: number): number[] {
    return Array.from({ length: 128 }, (_, i) => {
      const dist = Math.abs(i - peakBin);
      const val  = peakAmplitude - dist * 0.5 + this.gaussian(3);
      return +Math.max(-80, Math.min(0, val)).toFixed(2);
    });
  }

  generate(): GenerateResult {
    const scenario = scenarioManager.getScenario();

    let splBase: number;
    let classification: AcousticClass;
    let confidence: number;
    let aoaBase: number;
    let aoaRange: number;
    let durationMs: number;

    switch (scenario) {
      case 'INTRUSION':
        splBase        = 65 + Math.random() * 25;
        classification = Math.random() < 0.55 ? 'HUMAN_VOICE' : 'GUNSHOT';
        confidence     = 0.75 + Math.random() * 0.20;
        aoaBase        = 135;
        aoaRange       = 45;
        durationMs     = 200 + Math.floor(Math.random() * 1800);
        break;
      case 'DRONE':
        splBase        = 50 + Math.random() * 20;
        classification = 'MACHINERY';
        confidence     = 0.70 + Math.random() * 0.20;
        aoaBase        = Math.random() * 360;
        aoaRange       = 0;
        durationMs     = 5000 + Math.floor(Math.random() * 10000);
        break;
      case 'VEHICLE_CONVOY':
        splBase        = 70 + Math.random() * 20;
        classification = 'VEHICLE';
        confidence     = 0.80 + Math.random() * 0.15;
        aoaBase        = Math.random() * 360;
        aoaRange       = 0;
        durationMs     = 10000 + Math.floor(Math.random() * 30000);
        break;
      case 'TUNNEL_ACTIVITY':
        splBase        = 40 + Math.random() * 20;
        classification = 'MACHINERY';
        confidence     = 0.50 + Math.random() * 0.20;
        aoaBase        = Math.random() * 360;
        aoaRange       = 0;
        durationMs     = 30000 + Math.floor(Math.random() * 60000);
        break;
      case 'ELEVATED': {
        const mixedClasses: AcousticClass[] = ['VEHICLE', 'HUMAN_VOICE', 'ANIMAL', 'MACHINERY', 'AMBIENT'];
        splBase        = 50 + Math.random() * 25;
        classification = mixedClasses[Math.floor(Math.random() * mixedClasses.length)];
        confidence     = 0.40 + Math.random() * 0.45;
        aoaBase        = Math.random() * 360;
        aoaRange       = 0;
        durationMs     = 300 + Math.floor(Math.random() * 3000);
        break;
      }
      default:
        splBase        = 30 + Math.random() * 35;
        classification = Math.random() < 0.65 ? 'AMBIENT' : 'ANIMAL';
        confidence     = 0.30 + Math.random() * 0.30;
        aoaBase        = Math.random() * 360;
        aoaRange       = 0;
        durationMs     = 50 + Math.floor(Math.random() * 500);
        break;
    }

    const spl_db = +this.clamp(
      splBase + this.gaussian(splBase * 0.05), 0, 120
    ).toFixed(2);

    const angle_of_arrival = +(
      (aoaBase + Math.random() * aoaRange + this.gaussian(5) + 360) % 360
    ).toFixed(1);

    const classToMelPeak: Record<AcousticClass, number> = {
      GUNSHOT:     110,
      EXPLOSION:   105,
      VEHICLE:      60,
      MACHINERY:    55,
      HUMAN_VOICE:  35,
      ANIMAL:       28,
      AMBIENT:      15,
    };
    const peakBin       = classToMelPeak[classification] ?? 20;
    const peakAmplitude = -40 + (spl_db - 30) * 0.5;

    const rawValue = {
      spl_db,
      angle_of_arrival,
      classification,
      confidence:        +confidence.toFixed(3),
      frequency_profile: this.#melSpectrogram(peakBin, peakAmplitude),
      event_duration_ms: durationMs,
    };

    const isAlert = spl_db > 85 || classification === 'GUNSHOT' || classification === 'EXPLOSION';
    const processed = confidence > 0.60
      ? {
          event_detected:  true,
          classification,
          confidence:      +confidence.toFixed(3),
          alert_priority:  isAlert ? 'HIGH' : spl_db > 65 ? 'MEDIUM' : 'LOW',
        }
      : { event_detected: false };

    return { rawValue, processed };
  }
}
