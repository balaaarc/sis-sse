/**
 * wsServer.js
 * WebSocket server on port 4000.
 *
 * Outbound message types (SSE → Dashboard):
 *   SENSOR_DATA | AIML_DETECTION | AIML_TRACK_UPDATE | AIML_ALERT
 *   THREAT_ASSESSMENT | SYSTEM_HEALTH | SCENARIO_CHANGE
 *
 * Inbound message types (Dashboard → SSE):
 *   PTZ_CONTROL | ACKNOWLEDGE_ALERT | SUBSCRIBE
 */

import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import scenarioManager from './scenarioManager.js';

// Ring buffer keyed by sensor_id
class RingBuffer {
  #buffers = new Map();
  #maxAge;

  constructor(ringBufferSeconds = 60) {
    this.#maxAge = ringBufferSeconds * 1000;
  }

  push(sensorId, message) {
    if (!this.#buffers.has(sensorId)) this.#buffers.set(sensorId, []);
    const buf = this.#buffers.get(sensorId);
    buf.push({ ts: Date.now(), message });
    // evict entries older than maxAge
    const cutoff = Date.now() - this.#maxAge;
    while (buf.length > 0 && buf[0].ts < cutoff) buf.shift();
  }

  getRecent(sensorId) {
    return (this.#buffers.get(sensorId) ?? []).map((e) => e.message);
  }

  getAllRecent() {
    const out = [];
    for (const entries of this.#buffers.values()) {
      for (const e of entries) out.push(e.message);
    }
    return out.sort((a, b) => {
      const ta = a?.payload?.timestamp ?? '';
      const tb = b?.payload?.timestamp ?? '';
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
  }
}

// Acknowledged alerts store (in-memory)
const acknowledgedAlerts = new Map();

export function createWsServer(config, httpServer) {
  // Attach to a shared HTTP server so WS and REST share a single port
  const wss = new WebSocketServer({ server: httpServer });
  const clients = new Set();
  const ringBuffer = new RingBuffer(config.ring_buffer_seconds ?? 60);

  // Track per-client subscriptions: Map<ws, Set<modality>>
  const subscriptions = new Map();

  wss.on('connection', (ws, req) => {
    const clientId = uuidv4();
    ws._clientId = clientId;
    clients.add(ws);
    subscriptions.set(ws, new Set()); // empty = all modalities

    console.log(`[WS] Client connected: ${clientId} (total: ${clients.size})`);

    // Send welcome + recent ring buffer on connect
    safeSend(ws, {
      type: 'CONNECTED',
      payload: {
        client_id: clientId,
        scenario: scenarioManager.getScenario(),
        server_time: new Date().toISOString()
      }
    });

    // Replay last 10 sensor readings from ring buffer
    const recent = ringBuffer.getAllRecent().slice(-10);
    for (const msg of recent) {
      safeSend(ws, msg);
    }

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        safeSend(ws, { type: 'ERROR', payload: { message: 'Invalid JSON' } });
        return;
      }
      handleInbound(ws, msg, config);
    });

    ws.on('close', () => {
      clients.delete(ws);
      subscriptions.delete(ws);
      console.log(`[WS] Client disconnected: ${clientId} (total: ${clients.size})`);
    });

    ws.on('error', (err) => {
      console.error(`[WS] Client error (${clientId}):`, err.message);
    });
  });

  wss.on('error', (err) => {
    console.error('[WS] Server error:', err);
  });

  // Listen for scenario changes to broadcast SCENARIO_CHANGE
  scenarioManager.on('scenario_change', (detail) => {
    broadcast({ type: 'SCENARIO_CHANGE', payload: detail });
  });

  /**
   * Broadcast a message to all connected clients.
   * Respects per-client modality subscriptions.
   */
  function broadcast(message) {
    const raw = JSON.stringify(message);
    const modality = message?.payload?.modality ?? null;

    for (const ws of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      // Subscription filter: if client has subscribed to specific modalities
      const subs = subscriptions.get(ws);
      if (modality && subs && subs.size > 0 && !subs.has(modality)) continue;
      ws.send(raw);
    }

    // Add sensor data to ring buffer
    if (message.type === 'SENSOR_DATA' && message.payload?.sensor_id) {
      ringBuffer.push(message.payload.sensor_id, message);
    }
  }

  /**
   * Handle messages from the dashboard.
   */
  function handleInbound(ws, msg, config) {
    const { type, payload } = msg;

    switch (type) {
      case 'PTZ_CONTROL': {
        const { cameraId, command } = payload ?? {};
        console.log(`[WS] PTZ_CONTROL → camera=${cameraId} command=${JSON.stringify(command)}`);
        // Acknowledge back to sender
        safeSend(ws, {
          type: 'PTZ_ACK',
          payload: { cameraId, command, ack: true, timestamp: new Date().toISOString() }
        });
        break;
      }

      case 'ACKNOWLEDGE_ALERT': {
        const { alertId, user, comment } = payload ?? {};
        acknowledgedAlerts.set(alertId, { alertId, user, comment, ack_time: new Date().toISOString() });
        console.log(`[WS] Alert acknowledged: ${alertId} by ${user}`);
        broadcast({
          type: 'ALERT_ACKNOWLEDGED',
          payload: { alertId, user, comment, timestamp: new Date().toISOString() }
        });
        break;
      }

      case 'SUBSCRIBE': {
        const { filters } = payload ?? {};
        const subs = subscriptions.get(ws);
        if (Array.isArray(filters) && filters.length > 0) {
          subs.clear();
          filters.forEach((f) => subs.add(f));
          console.log(`[WS] Client ${ws._clientId} subscribed to: ${filters.join(', ')}`);
        } else {
          subs.clear(); // subscribe to all
          console.log(`[WS] Client ${ws._clientId} subscribed to: ALL`);
        }
        safeSend(ws, {
          type: 'SUBSCRIBE_ACK',
          payload: { filters: filters ?? [], timestamp: new Date().toISOString() }
        });
        break;
      }

      default:
        safeSend(ws, { type: 'ERROR', payload: { message: `Unknown message type: ${type}` } });
    }
  }

  function safeSend(ws, message) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    } catch (err) {
      console.error('[WS] safeSend error:', err.message);
    }
  }

  return {
    wss,
    broadcast,
    getClientCount: () => clients.size,
    getAcknowledgedAlerts: () => acknowledgedAlerts,
    getRingBuffer: () => ringBuffer
  };
}
