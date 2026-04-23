import { BaseGenerator } from './base.js';
import { scenarioManager } from '../scenarioManager.js';
import type { GeneratorOpts, GenerateResult } from '../types.js';

type Compound = 'RDX' | 'TNT' | 'PETN' | 'NH4NO3' | 'NONE';

const ALL_COMPOUNDS: Compound[]  = ['RDX', 'TNT', 'PETN', 'NH4NO3'];
const EXPLOSIVE_PAIR: Compound[] = ['RDX', 'TNT', 'PETN'];

export class ChemicalGenerator extends BaseGenerator {
  #detectorTemp = 33 + Math.random() * 5;

  constructor(opts: GeneratorOpts) {
    super({ noiseSigma: 0.01, ...opts });
  }

  generate(): GenerateResult {
    const scenario = scenarioManager.getScenario();

    let compound_id: Compound;
    let concentration_ppb: number;
    let extraCompounds: Array<{ compound_id: string; concentration_ppb: number }> = [];

    switch (scenario) {
      case 'INTRUSION':
        if (Math.random() < 0.30) {
          compound_id       = EXPLOSIVE_PAIR[Math.floor(Math.random() * EXPLOSIVE_PAIR.length)];
          concentration_ppb = +(5 + Math.random() * 20).toFixed(4);
        } else {
          compound_id       = 'NONE';
          concentration_ppb = +(Math.random() * 0.5).toFixed(4);
        }
        break;
      case 'TUNNEL_ACTIVITY':
        compound_id       = 'NH4NO3';
        concentration_ppb = +(8 + Math.random() * 22).toFixed(4);
        break;
      case 'ELEVATED':
        if (Math.random() < 0.10) {
          compound_id       = ALL_COMPOUNDS[Math.floor(Math.random() * ALL_COMPOUNDS.length)];
          concentration_ppb = +(1 + Math.random() * 5).toFixed(4);
        } else {
          compound_id       = 'NONE';
          concentration_ppb = +(Math.random() * 0.5).toFixed(4);
        }
        break;
      default:
        compound_id       = 'NONE';
        concentration_ppb = +Math.max(0, Math.random() * 0.5 + this.gaussian(0.05)).toFixed(4);
        break;
    }

    concentration_ppb = +Math.max(
      0,
      concentration_ppb + this.gaussian(concentration_ppb * 0.05 + 0.01)
    ).toFixed(4);

    const alarm = compound_id !== 'NONE' && concentration_ppb > 10;

    if (compound_id !== 'NONE' && Math.random() < 0.25) {
      const others = ALL_COMPOUNDS.filter((c) => c !== compound_id);
      const trace  = others[Math.floor(Math.random() * others.length)];
      extraCompounds = [{ compound_id: trace, concentration_ppb: +(0.1 + Math.random() * 1.5).toFixed(4) }];
    }

    const compounds = [{ compound_id, concentration_ppb }, ...extraCompounds];

    this.#detectorTemp += this.gaussian(0.2);
    this.#detectorTemp  = this.clamp(this.#detectorTemp, 25, 55);

    const rawValue = {
      compound_id,
      concentration_ppb,
      alarm,
      detector_temp_c: +this.#detectorTemp.toFixed(2),
      compounds,
    };

    const processed = alarm
      ? {
          event_detected: true,
          classification: compound_id,
          alert_priority: concentration_ppb > 20 ? 'HIGH' : 'MEDIUM',
        }
      : { event_detected: false };

    return { rawValue, processed };
  }
}
