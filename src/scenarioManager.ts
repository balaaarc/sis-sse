import { EventEmitter } from 'events';
import { logger } from './logger.js';
import type { ScenarioName } from './types.js';

const VALID_SCENARIOS: ScenarioName[] = [
  'NORMAL',
  'ELEVATED',
  'INTRUSION',
  'TUNNEL_ACTIVITY',
  'DRONE',
  'VEHICLE_CONVOY',
];

class ScenarioManager extends EventEmitter {
  #scenario: ScenarioName = 'NORMAL';
  #changedAt: number = Date.now();

  setScenario(name: string): void {
    if (!VALID_SCENARIOS.includes(name as ScenarioName)) {
      throw new RangeError(`Unknown scenario: ${name}. Valid: ${VALID_SCENARIOS.join(', ')}`);
    }
    const previous = this.#scenario;
    this.#scenario = name as ScenarioName;
    this.#changedAt = Date.now();
    logger.info({ previous, current: name }, 'Scenario changed');
    this.emit('scenario_change', { previous, current: name, timestamp: new Date().toISOString() });
  }

  getScenario(): ScenarioName {
    return this.#scenario;
  }

  getChangedAt(): number {
    return this.#changedAt;
  }

  isElevated(): boolean {
    return this.#scenario !== 'NORMAL';
  }

  getValidScenarios(): ScenarioName[] {
    return [...VALID_SCENARIOS];
  }
}

export const scenarioManager = new ScenarioManager();
