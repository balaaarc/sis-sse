import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { scenarioManager } from './scenarioManager.js';
import { logger } from './logger.js';
import type { AppConfig, WsMessage, IWsServer, IRingBuffer, AckDetail } from './types.js';

interface ExtWebSocket extends WebSocket {
  _clientId: string;
}

class RingBuffer implements IRingBuffer {
  #buffers = new Map<string, Array<{ ts: number; message: WsMessage }>>();
  #maxAge: number;

  constructor(ringBufferSeconds = 60) {
    this.#maxAge = ringBufferSeconds * 1000;
  }

  push(sensorId: string, message: WsMessage): void {
    if (!this.#buffers.has(sensorId)) this.#buffers.set(sensorId, []);
    const buf = this.#buffers.get(sensorId)!;
    buf.push({ ts: Date.now(), message });
    const cutoff = Date.now() - this.#maxAge;
    while (buf.length > 0 && buf[0].ts < cutoff) buf.shift();
  }

  getRecent(sensorId: string): WsMessage[] {
    return (this.#buffers.get(sensorId) ?? []).map((e) => e.message);
  }

  getAllRecent(): WsMessage[] {
    const out: WsMessage[] = [];
    for (const entries of this.#buffers.values()) {
      for (const e of entries) out.push(e.message);
    }
    return out.sort((a, b) => {
      const ta = (a?.payload as Record<string, string>)?.timestamp ?? '';
      const tb = (b?.payload as Record<string, string>)?.timestamp ?? '';
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
  }
}

const acknowledgedAlerts = new Map<string, AckDetail>();

export function createWsServer(config: AppConfig, httpServer: Server): IWsServer {
  const wss = new WebSocketServer({ server: httpServer });
  const clients = new Set<ExtWebSocket>();
  const ringBuffer = new RingBuffer(config.ring_buffer_seconds ?? 60);
  const subscriptions = new Map<ExtWebSocket, Set<string>>();

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    const extWs = ws as ExtWebSocket;
    const clientId = uuidv4();
    extWs._clientId = clientId;
    clients.add(extWs);
    subscriptions.set(extWs, new Set());

    logger.info({ clientId, total: clients.size }, 'Client connected');

    safeSend(extWs, {
      type: 'CONNECTED',
      payload: {
        client_id: clientId,
        scenario: scenarioManager.getScenario(),
        server_time: new Date().toISOString(),
      },
    });

    const recent = ringBuffer.getAllRecent().slice(-10);
    for (const msg of recent) safeSend(extWs, msg);

    extWs.on('message', (raw: Buffer) => {
      let msg: { type: string; payload: Record<string, unknown> };
      try {
        msg = JSON.parse(raw.toString()) as typeof msg;
      } catch {
        safeSend(extWs, { type: 'ERROR', payload: { message: 'Invalid JSON' } });
        return;
      }
      handleInbound(extWs, msg);
    });

    extWs.on('close', () => {
      clients.delete(extWs);
      subscriptions.delete(extWs);
      logger.info({ clientId, total: clients.size }, 'Client disconnected');
    });

    extWs.on('error', (err: Error) => {
      logger.error({ clientId, err: err.message }, 'Client error');
    });
  });

  wss.on('error', (err: Error) => {
    logger.error(err, 'WS server error');
  });

  scenarioManager.on('scenario_change', (detail: unknown) => {
    broadcast({ type: 'SCENARIO_CHANGE', payload: detail });
  });

  function broadcast(message: WsMessage): void {
    const raw = JSON.stringify(message);
    const modality = (message?.payload as Record<string, string> | null)?.modality ?? null;

    for (const ws of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const subs = subscriptions.get(ws);
      if (modality && subs && subs.size > 0 && !subs.has(modality)) continue;
      ws.send(raw);
    }

    const payload = message.payload as Record<string, unknown> | null;
    if (message.type === 'SENSOR_DATA' && payload?.sensor_id) {
      ringBuffer.push(payload.sensor_id as string, message);
    }
  }

  function handleInbound(
    ws: ExtWebSocket,
    msg: { type: string; payload: Record<string, unknown> }
  ): void {
    const { type, payload } = msg;

    switch (type) {
      case 'PTZ_CONTROL': {
        const { cameraId, command } = payload ?? {};
        logger.info({ cameraId, command }, 'PTZ_CONTROL received');
        safeSend(ws, {
          type: 'PTZ_ACK',
          payload: { cameraId, command, ack: true, timestamp: new Date().toISOString() },
        });
        break;
      }

      case 'ACKNOWLEDGE_ALERT': {
        const { alertId, user, comment } = payload ?? {};
        acknowledgedAlerts.set(alertId as string, {
          alertId: alertId as string,
          user: user as string,
          comment: comment as string,
          ack_time: new Date().toISOString(),
        });
        logger.info({ alertId, user }, 'Alert acknowledged');
        broadcast({
          type: 'ALERT_ACKNOWLEDGED',
          payload: { alertId, user, comment, timestamp: new Date().toISOString() },
        });
        break;
      }

      case 'SUBSCRIBE': {
        const { filters } = payload ?? {};
        const subs = subscriptions.get(ws);
        if (subs && Array.isArray(filters) && filters.length > 0) {
          subs.clear();
          (filters as string[]).forEach((f) => subs.add(f));
          logger.info({ clientId: ws._clientId, filters }, 'Client subscribed to modalities');
        } else if (subs) {
          subs.clear();
          logger.info({ clientId: ws._clientId }, 'Client subscribed to ALL');
        }
        safeSend(ws, {
          type: 'SUBSCRIBE_ACK',
          payload: { filters: filters ?? [], timestamp: new Date().toISOString() },
        });
        break;
      }

      default:
        safeSend(ws, { type: 'ERROR', payload: { message: `Unknown message type: ${type}` } });
    }
  }

  function safeSend(ws: ExtWebSocket, message: WsMessage): void {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'safeSend error');
    }
  }

  return {
    wss,
    broadcast,
    getClientCount: () => clients.size,
    getAcknowledgedAlerts: () => acknowledgedAlerts,
    getRingBuffer: () => ringBuffer,
  };
}
