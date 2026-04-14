/**
 * restServer.js
 * Fastify REST API server on port 4001.
 *
 * Routes:
 *   GET  /api/health
 *   GET  /api/sensors
 *   GET  /api/sensors/:id/history
 *   GET  /api/alerts
 *   GET  /api/system-health
 *   POST /api/scenario
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import scenarioManager from './scenarioManager.js';

// In-memory alert store (also populated by correlator via wsServer broadcast interception)
export const alertStore = [];
const MAX_ALERTS = 100;

export function addAlert(alert) {
  alertStore.unshift(alert);
  if (alertStore.length > MAX_ALERTS) alertStore.length = MAX_ALERTS;
}

// Sensor registry – populated by generators on startup
export const sensorRegistry = new Map();

export function registerSensor(sensorId, meta) {
  sensorRegistry.set(sensorId, { ...meta, last_seen: null, last_reading: null });
}

export function updateSensorReading(sensorId, payload) {
  const entry = sensorRegistry.get(sensorId);
  if (entry) {
    entry.last_seen = payload.timestamp;
    entry.last_reading = payload;
  }
}

export async function createRestServer(config, wsServer, httpServer) {
  // Use serverFactory so Fastify shares the same HTTP server as the WS server
  const app = Fastify({
    logger: false,
    serverFactory: (handler) => {
      httpServer.on('request', handler);
      return httpServer;
    }
  });

  // CORS – allow both local dev and the deployed GitHub Pages origin
  const allowedOrigins = [
    ...config.cors_origins,
    'https://balaaarc.github.io'
  ];
  await app.register(cors, {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'OPTIONS']
  });

  // ── GET /api/health ─────────────────────────────────────────────────────
  app.get('/api/health', async (req, reply) => {
    return {
      status: 'ok',
      service: 'iinvsys-sse',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      uptime_s: process.uptime().toFixed(2),
      scenario: scenarioManager.getScenario(),
      ws_clients: wsServer.getClientCount()
    };
  });

  // ── GET /api/sensors ────────────────────────────────────────────────────
  app.get('/api/sensors', async (req, reply) => {
    const sensors = [];
    for (const [id, meta] of sensorRegistry.entries()) {
      sensors.push({
        sensor_id: id,
        modality: meta.modality,
        site_id: meta.site_id,
        bop_id: meta.bop_id,
        sensor_status: meta.last_reading?.sensor_status ?? 'ONLINE',
        quality_score: meta.last_reading?.quality_score ?? 1.0,
        firmware_ver: meta.last_reading?.firmware_ver ?? '1.0.0',
        last_seen: meta.last_seen,
        update_rate_hz: meta.update_rate_hz
      });
    }
    return { count: sensors.length, sensors };
  });

  // ── GET /api/sensors/:id/history ────────────────────────────────────────
  app.get('/api/sensors/:id/history', async (req, reply) => {
    const { id } = req.params;
    if (!sensorRegistry.has(id)) {
      return reply.code(404).send({ error: `Sensor ${id} not found` });
    }
    const ring = wsServer.getRingBuffer();
    const history = ring.getRecent(id).slice(-100);
    return {
      sensor_id: id,
      count: history.length,
      readings: history.map((m) => m.payload)
    };
  });

  // ── GET /api/alerts ─────────────────────────────────────────────────────
  app.get('/api/alerts', async (req, reply) => {
    const acknowledged = wsServer.getAcknowledgedAlerts();
    const enriched = alertStore.map((a) => ({
      ...a,
      acknowledged: acknowledged.has(a.alert_id),
      ack_detail: acknowledged.get(a.alert_id) ?? null
    }));
    return { count: enriched.length, alerts: enriched };
  });

  // ── GET /api/system-health ──────────────────────────────────────────────
  app.get('/api/system-health', async (req, reply) => {
    const site = config.sites[0];
    const jitter = (base, range) => +(base + (Math.random() - 0.5) * range).toFixed(1);
    return {
      timestamp: new Date().toISOString(),
      node_id: site.site_id,
      hardware: {
        cpu_percent:    jitter(45, 20),
        gpu_percent:    jitter(67, 15),
        ram_percent:    jitter(52, 10),
        nvme_percent:   jitter(23, 5),
        temperature_c:  jitter(52, 8),
        uptime_hours:   +(process.uptime() / 3600).toFixed(2)
      },
      comms: {
        SATCOM:  { active: true, signal_quality: jitter(0.87, 0.1) },
        LTE:     { active: true, signal_quality: jitter(0.92, 0.1) },
        VHF_UHF: { active: Math.random() > 0.3, signal_quality: jitter(0.3, 0.6) },
        LORA:    { active: true, signal_quality: jitter(0.76, 0.15) },
        WIFI6:   { active: true, signal_quality: jitter(0.95, 0.08) },
        BLE:     { active: true, signal_quality: jitter(0.88, 0.1) }
      },
      aiml: {
        inference_fps:      jitter(24.5, 3),
        gpu_memory_percent: jitter(71.2, 10),
        model_versions: {
          detection: 'yolov9-v1.2',
          tracking:  'bytetrack-v2.0',
          threat:    'bayesian-v3.1'
        }
      }
    };
  });

  // ── POST /api/scenario ──────────────────────────────────────────────────
  app.post('/api/scenario', {
    schema: {
      body: {
        type: 'object',
        required: ['scenario'],
        properties: {
          scenario: { type: 'string' }
        }
      }
    }
  }, async (req, reply) => {
    const { scenario } = req.body;
    try {
      scenarioManager.setScenario(scenario);
      // Broadcast scenario change via WS
      wsServer.broadcast({
        type: 'SCENARIO_CHANGE',
        payload: {
          previous: null,
          current: scenario,
          timestamp: new Date().toISOString()
        }
      });
      return {
        success: true,
        scenario,
        timestamp: new Date().toISOString()
      };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ── Initialise Fastify (don't call listen – the shared httpServer handles that) ──
  await app.ready();

  return app;
}
