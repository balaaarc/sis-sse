/**
 * scenarioManager.js
 * Singleton that holds the active simulation scenario.
 * Generators read getScenario() on every tick to adjust their output distributions.
 */

import { EventEmitter } from 'events';
import { logger } from './logger.js';

const VALID_SCENARIOS = [
  'NORMAL',
  'ELEVATED',
  'INTRUSION',
  'TUNNEL_ACTIVITY',
  'DRONE',
  'VEHICLE_CONVOY'
];

class ScenarioManager extends EventEmitter {
  #scenario = 'NORMAL';
  #changedAt = Date.now();

  setScenario(name) {
    if (!VALID_SCENARIOS.includes(name)) {
      throw new RangeError(`Unknown scenario: ${name}. Valid: ${VALID_SCENARIOS.join(', ')}`);
    }
    const previous = this.#scenario;
    this.#scenario = name;
    this.#changedAt = Date.now();
    logger.info({ previous, current: name }, 'Scenario changed');
    this.emit('scenario_change', { previous, current: name, timestamp: new Date().toISOString() });
  }

  getScenario() {
    return this.#scenario;
  }

  getChangedAt() {
    return this.#changedAt;
  }

  isElevated() {
    return this.#scenario !== 'NORMAL';
  }

  getValidScenarios() {
    return [...VALID_SCENARIOS];
  }
}

// Export as singleton
export const scenarioManager = new ScenarioManager();
