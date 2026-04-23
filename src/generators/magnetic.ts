import { BaseGenerator } from './base.js';
import { scenarioManager } from '../scenarioManager.js';
import type { GeneratorOpts, GenerateResult } from '../types.js';

type EmiClass = 'METAL' | 'WIRE' | 'CLEAR';

export class MagneticGenerator extends BaseGenerator {
  #baselineNt = 48000 + (Math.random() - 0.5) * 2000;

  constructor(opts: GeneratorOpts) {
    super({ noiseSigma: 0.015, ...opts });
  }

  #buildMad(scenario: string): Record<string, unknown> {
    let deltaBase: number;
    let anomaly_flag: boolean;
    let confidence: number;

    switch (scenario) {
      case 'INTRUSION':
        deltaBase    = 150 + Math.random() * 150;
        anomaly_flag = true;
        confidence   = +(0.65 + Math.random() * 0.30).toFixed(3) as unknown as number;
        break;
      case 'VEHICLE_CONVOY':
        deltaBase    = 500 + Math.random() * 1500;
        anomaly_flag = true;
        confidence   = +(0.80 + Math.random() * 0.18).toFixed(3) as unknown as number;
        break;
      case 'TUNNEL_ACTIVITY':
        deltaBase    = 100 + Math.random() * 100;
        anomaly_flag = deltaBase > 150;
        confidence   = +(0.55 + Math.random() * 0.30).toFixed(3) as unknown as number;
        break;
      case 'ELEVATED':
        deltaBase    = 30 + Math.random() * 80;
        anomaly_flag = deltaBase > 70;
        confidence   = +(0.45 + Math.random() * 0.35).toFixed(3) as unknown as number;
        break;
      default:
        deltaBase    = (Math.random() - 0.5) * 100;
        anomaly_flag = false;
        confidence   = +(0.30 + Math.random() * 0.30).toFixed(3) as unknown as number;
        break;
    }

    const field_delta_nt = +(deltaBase + this.gaussian(deltaBase * 0.05)).toFixed(3);
    this.#baselineNt += this.gaussian(0.5);
    return { field_delta_nt, anomaly_flag, baseline_nt: +this.#baselineNt.toFixed(2), confidence };
  }

  #buildMagnetometer(scenario: string): Record<string, unknown> {
    let metalMassBase: number;
    let confidence: number;

    switch (scenario) {
      case 'VEHICLE_CONVOY':
        metalMassBase = 50 + Math.random() * 150;
        confidence    = +(0.82 + Math.random() * 0.15).toFixed(3) as unknown as number;
        break;
      case 'INTRUSION':
        metalMassBase = 5 + Math.random() * 15;
        confidence    = +(0.65 + Math.random() * 0.25).toFixed(3) as unknown as number;
        break;
      case 'ELEVATED':
        metalMassBase = 2 + Math.random() * 8;
        confidence    = +(0.40 + Math.random() * 0.35).toFixed(3) as unknown as number;
        break;
      default:
        metalMassBase = Math.random() * 5;
        confidence    = +(0.20 + Math.random() * 0.30).toFixed(3) as unknown as number;
        break;
    }

    const metal_mass_kg_equiv = +Math.max(0, metalMassBase + this.gaussian(metalMassBase * 0.08)).toFixed(3);
    const field_x_nt = +((this.#baselineNt * 0.30) + this.gaussian(20)).toFixed(2);
    const field_y_nt = +((this.#baselineNt * 0.10) + this.gaussian(20)).toFixed(2);
    const field_z_nt = +((this.#baselineNt * 0.95) + this.gaussian(20)).toFixed(2);
    return { metal_mass_kg_equiv, confidence, field_x_nt, field_y_nt, field_z_nt };
  }

  #buildEmi(scenario: string): Record<string, unknown> {
    let anomalyBase: number;
    let classification: EmiClass;
    let confidence: number;

    switch (scenario) {
      case 'TUNNEL_ACTIVITY':
        anomalyBase    = 0.50 + Math.random() * 0.45;
        classification = 'METAL';
        confidence     = +(0.55 + Math.random() * 0.30).toFixed(3) as unknown as number;
        break;
      case 'VEHICLE_CONVOY':
        anomalyBase    = 0.70 + Math.random() * 0.30;
        classification = Math.random() < 0.7 ? 'METAL' : 'WIRE';
        confidence     = +(0.75 + Math.random() * 0.22).toFixed(3) as unknown as number;
        break;
      case 'INTRUSION':
        anomalyBase    = 0.30 + Math.random() * 0.50;
        classification = Math.random() < 0.5 ? 'METAL' : 'WIRE';
        confidence     = +(0.55 + Math.random() * 0.30).toFixed(3) as unknown as number;
        break;
      default:
        anomalyBase    = Math.random() * 0.15;
        classification = 'CLEAR';
        confidence     = +(0.20 + Math.random() * 0.30).toFixed(3) as unknown as number;
        break;
    }

    const inductance_anomaly = +this.clamp(anomalyBase + this.gaussian(0.03), 0, 1).toFixed(4);
    const buried_object_signature = Array.from({ length: 32 }, (_, i) => {
      const base = classification !== 'CLEAR'
        ? inductance_anomaly * Math.exp(-0.05 * (i - 16) ** 2)
        : 0;
      return +Math.max(0, base + this.gaussian(0.02)).toFixed(4);
    });

    return { inductance_anomaly, buried_object_signature, classification, confidence };
  }

  generate(): GenerateResult {
    const scenario = scenarioManager.getScenario();
    let rawValue: Record<string, unknown>;

    switch (this.modality) {
      case 'MAD':          rawValue = this.#buildMad(scenario);          break;
      case 'MAGNETOMETER': rawValue = this.#buildMagnetometer(scenario); break;
      case 'EMI':          rawValue = this.#buildEmi(scenario);          break;
      default:             rawValue = { error: `Unknown magnetic modality: ${this.modality}` };
    }

    const isAlert =
      (this.modality === 'MAD'          && (rawValue.anomaly_flag as boolean)) ||
      (this.modality === 'MAGNETOMETER' && (rawValue.metal_mass_kg_equiv as number) > 10) ||
      (this.modality === 'EMI'          && (rawValue.inductance_anomaly as number) > 0.50);

    const processed = isAlert
      ? {
          event_detected: true,
          alert_priority: (rawValue.confidence as number) > 0.75 ? 'HIGH' : 'MEDIUM',
        }
      : { event_detected: false };

    return { rawValue, processed };
  }
}
