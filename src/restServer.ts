import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import type { Server } from 'http';
import { logger } from './logger.js';
import { scenarioManager } from './scenarioManager.js';
import type { AppConfig, IWsServer, BasePayload, AlertRecord, SensorMeta } from './types.js';

export const alertStore: AlertRecord[] = [];
const MAX_ALERTS = 100;

export function addAlert(alert: AlertRecord): void {
  alertStore.unshift(alert);
  if (alertStore.length > MAX_ALERTS) alertStore.length = MAX_ALERTS;
}

export const sensorRegistry = new Map<string, SensorMeta>();

export function registerSensor(sensorId: string, meta: Omit<SensorMeta, 'last_seen' | 'last_reading'>): void {
  sensorRegistry.set(sensorId, { ...meta, last_seen: null, last_reading: null });
}

export function updateSensorReading(sensorId: string, payload: BasePayload): void {
  const entry = sensorRegistry.get(sensorId);
  if (entry) {
    entry.last_seen = payload.timestamp;
    entry.last_reading = payload;
  }
}

// ── Zod schemas ──────────────────────────────────────────────────────────────
const ScenarioBody = z.object({ scenario: z.string().min(1) });
const SensorIdParam = z.object({ id: z.string().min(1) });
const AlertsQuery = z.object({
  page:  z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function createRestServer(
  config: AppConfig,
  wsServer: IWsServer,
  httpServer: Server
): Promise<FastifyInstance> {
  const jwtSecret = process.env.SSE_JWT_SECRET;
  if (!jwtSecret) {
    logger.warn('SSE_JWT_SECRET not set — REST API is unauthenticated (dev mode)');
  }

  const app = Fastify({
    logger: false,
    serverFactory: (handler) => {
      httpServer.on('request', handler);
      return httpServer;
    },
  });

  const allowedOrigins = [...config.cors_origins, 'https://balaaarc.github.io'];
  await app.register(cors, {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  // ── JWT auth hook ────────────────────────────────────────────────────────
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url.startsWith('/api/health')) return;
    if (!jwtSecret) return; // dev mode — unauthenticated

    const authHeader = (req.headers['authorization'] as string | undefined) ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    try {
      jwt.verify(token, jwtSecret);
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // ── GET /api/health ──────────────────────────────────────────────────────
  app.get('/api/health', async (_req, _reply) => ({
    status: 'ok',
    service: 'iinvsys-sse',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime_s: process.uptime().toFixed(2),
    scenario: scenarioManager.getScenario(),
    ws_clients: wsServer.getClientCount(),
  }));

  // ── GET /api/sensors ─────────────────────────────────────────────────────
  app.get('/api/sensors', async (_req, _reply) => {
    const sensors = [];
    for (const [id, meta] of sensorRegistry.entries()) {
      sensors.push({
        sensor_id:      id,
        modality:       meta.modality,
        site_id:        meta.site_id,
        bop_id:         meta.bop_id,
        sensor_status:  meta.last_reading?.sensor_status ?? 'ONLINE',
        quality_score:  meta.last_reading?.quality_score ?? 1.0,
        firmware_ver:   meta.last_reading?.firmware_ver ?? '1.0.0',
        last_seen:      meta.last_seen,
        update_rate_hz: meta.update_rate_hz,
      });
    }
    return { count: sensors.length, sensors };
  });

  // ── GET /api/sensors/:id/history ─────────────────────────────────────────
  app.get('/api/sensors/:id/history', async (req, reply) => {
    const paramResult = SensorIdParam.safeParse(req.params);
    if (!paramResult.success) return reply.code(400).send({ error: 'Invalid sensor id' });
    const { id } = paramResult.data;
    if (!sensorRegistry.has(id)) return reply.code(404).send({ error: `Sensor ${id} not found` });
    const ring = wsServer.getRingBuffer();
    const history = ring.getRecent(id).slice(-100);
    return { sensor_id: id, count: history.length, readings: history.map((m) => m.payload) };
  });

  // ── GET /api/alerts ──────────────────────────────────────────────────────
  app.get('/api/alerts', async (req, reply) => {
    const queryResult = AlertsQuery.safeParse(req.query);
    if (!queryResult.success) return reply.code(400).send({ error: queryResult.error.issues });
    const { page, limit } = queryResult.data;

    const acknowledged = wsServer.getAcknowledgedAlerts();
    const enriched = alertStore.map((a) => ({
      ...a,
      acknowledged: acknowledged.has(a.alert_id),
      ack_detail:   acknowledged.get(a.alert_id) ?? null,
    }));

    const total = enriched.length;
    const start = (page - 1) * limit;
    const items = enriched.slice(start, start + limit);

    return { total, page, limit, count: items.length, alerts: items };
  });

  // ── GET /api/system-health ───────────────────────────────────────────────
  app.get('/api/system-health', async (_req, _reply) => {
    const site = config.sites[0];
    const jitter = (base: number, range: number) =>
      +(base + (Math.random() - 0.5) * range).toFixed(1);
    return {
      timestamp: new Date().toISOString(),
      node_id: site.site_id,
      hardware: {
        cpu_percent:   jitter(45, 20),
        gpu_percent:   jitter(67, 15),
        ram_percent:   jitter(52, 10),
        nvme_percent:  jitter(23, 5),
        temperature_c: jitter(52, 8),
        uptime_hours:  +(process.uptime() / 3600).toFixed(2),
      },
      comms: {
        SATCOM:  { active: true,                  signal_quality: jitter(0.87, 0.1)  },
        LTE:     { active: true,                  signal_quality: jitter(0.92, 0.1)  },
        VHF_UHF: { active: Math.random() > 0.3,   signal_quality: jitter(0.3,  0.6)  },
        LORA:    { active: true,                  signal_quality: jitter(0.76, 0.15) },
        WIFI6:   { active: true,                  signal_quality: jitter(0.95, 0.08) },
        BLE:     { active: true,                  signal_quality: jitter(0.88, 0.1)  },
      },
      aiml: {
        inference_fps:      jitter(24.5, 3),
        gpu_memory_percent: jitter(71.2, 10),
        model_versions: {
          detection: 'yolov9-v1.2',
          tracking:  'bytetrack-v2.0',
          threat:    'bayesian-v3.1',
        },
      },
    };
  });

  // ── POST /api/scenario ───────────────────────────────────────────────────
  app.post('/api/scenario', async (req, reply) => {
    const result = ScenarioBody.safeParse(req.body);
    if (!result.success) return reply.code(400).send({ error: result.error.issues });
    const { scenario } = result.data;
    try {
      scenarioManager.setScenario(scenario);
      wsServer.broadcast({
        type: 'SCENARIO_CHANGE',
        payload: { previous: null, current: scenario, timestamp: new Date().toISOString() },
      });
      return { success: true, scenario, timestamp: new Date().toISOString() };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  await app.ready();
  return app;
}
