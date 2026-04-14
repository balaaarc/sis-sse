/**
 * scenarioManager.js
 * Singleton that holds the active simulation scenario.
 * Generators read getScenario() on every tick to adjust their output distributions.
 */

import { EventEmitter } from 'events';

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
    console.log(`[ScenarioManager] Scenario changed: ${previous} → ${name}`);
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
const scenarioManager = new ScenarioManager();
export default scenarioManager;
