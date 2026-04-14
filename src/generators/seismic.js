/**
 * seismic.js
 * Covers S02 (Geophone / SEISMIC) and S09 (VIBRATION).
 * Update rate: 100 Hz (10 ms interval).
 *
 * raw_value schema:
 *   pgv           – peak ground velocity mm/s
 *   rms           – RMS mm/s
 *   dominant_freq – Hz
 *   waveform      – 100 floats at 100 Hz
 *   fft_magnitude – 64 floats dB
 *   classification – HUMAN_FOOTFALL | VEHICLE | ANIMAL | MACHINERY | NOISE
 *   confidence    – 0-1
 */

import { BaseGenerator } from './base.js';
import scenarioManager from '../scenarioManager.js';

const CLASSIFICATIONS = ['HUMAN_FOOTFALL', 'VEHICLE', 'ANIMAL', 'MACHINERY', 'NOISE'];

export default class SeismicGenerator extends BaseGenerator {
  #waveformBuffer = new Array(100).fill(0);

  constructor(opts) {
    super({ noiseSigma: 0.02, ...opts });
  }

  generate() {
    const scenario = scenarioManager.getScenario();

    // Base amplitude varies by scenario
    let pgvBase, classification, confidence, freqBase;

    switch (scenario) {
      case 'INTRUSION':
        pgvBase       = 2 + Math.random() * 6;        // 2-8 mm/s
        classification = Math.random() < 0.7 ? 'HUMAN_FOOTFALL' : 'VEHICLE';
        confidence    = 0.75 + Math.random() * 0.25;
        freqBase      = 8 + Math.random() * 6;         // 8-14 Hz human
        break;
      case 'TUNNEL_ACTIVITY':
        pgvBase       = 1 + Math.random() * 2;         // 1-3 mm/s
        classification = 'MACHINERY';
        confidence    = 0.65 + Math.random() * 0.25;
        freqBase      = 20 + Math.random() * 30;       // machinery freq
        break;
      case 'VEHICLE_CONVOY':
        pgvBase       = 3 + Math.random() * 5;
        classification = 'VEHICLE';
        confidence    = 0.80 + Math.random() * 0.20;
        freqBase      = 15 + Math.random() * 20;
        break;
      case 'DRONE':
        pgvBase       = 0.05 + Math.random() * 0.2;
        classification = Math.random() < 0.5 ? 'NOISE' : 'MACHINERY';
        confidence    = 0.35 + Math.random() * 0.3;
        freqBase      = 40 + Math.random() * 60;       // high freq rotor
        break;
      case 'ELEVATED':
        pgvBase       = 0.3 + Math.random() * 1.0;
        classification = CLASSIFICATIONS[Math.floor(Math.random() * CLASSIFICATIONS.length)];
        confidence    = 0.50 + Math.random() * 0.3;
        freqBase      = 10 + Math.random() * 20;
        break;
      default: // NORMAL
        pgvBase       = 0.01 + Math.random() * 0.08;
        classification = Math.random() < 0.6 ? 'NOISE' : 'ANIMAL';
        confidence    = 0.40 + Math.random() * 0.35;
        freqBase      = 2 + Math.random() * 8;
        break;
    }

    const pgv = +(pgvBase + this.gaussian(pgvBase * 0.1)).toFixed(4);
    const rms = +(pgv * (0.5 + Math.random() * 0.3)).toFixed(4);
    const dominant_freq = +(freqBase + this.gaussian(1)).toFixed(2);

    // Generate waveform: shift buffer and add new sample
    this.#waveformBuffer.shift();
    const newSample = pgv * Math.sin(2 * Math.PI * dominant_freq * (Date.now() / 1000)) + this.gaussian(pgv * 0.05);
    this.#waveformBuffer.push(+newSample.toFixed(5));

    // Synthetic FFT magnitude (64 bins, peak at dominant_freq bin)
    const fft_magnitude = Array.from({ length: 64 }, (_, i) => {
      const freqBin = i * (100 / 64); // 0-100 Hz
      const dist = Math.abs(freqBin - dominant_freq);
      const peak = Math.max(0, 20 - dist * 2) + this.gaussian(2);
      return +Math.max(-60, peak - 40 + this.gaussian(5)).toFixed(2);
    });

    const rawValue = {
      pgv,
      rms,
      dominant_freq,
      waveform:       [...this.#waveformBuffer],
      fft_magnitude,
      classification,
      confidence:     +confidence.toFixed(3)
    };

    // Processed AIML output
    const processed = confidence > 0.65
      ? {
          event_detected: true,
          classification,
          confidence: +confidence.toFixed(3),
          alert_priority: pgv > 1.0 ? 'HIGH' : pgv > 0.3 ? 'MEDIUM' : 'LOW'
        }
      : { event_detected: false };

    return { rawValue, processed };
  }
}
