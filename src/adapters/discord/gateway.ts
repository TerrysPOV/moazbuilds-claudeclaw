/**
 * Real Discord gateway implementation for the Bus runtime.
 *
 * Implements `DiscordGatewayLike` so it can drop into `DiscordAdapter` in
 * place of the test `FakeDiscordGateway`. Ported from the module-level
 * gateway loop in `src/commands/discord.ts` (~lines 1582–1908) and
 * wrapped in a class so each adapter instance owns its own connection,
 * heartbeat timers, and session state.
 *
 * Scope is intentionally small: emit `MESSAGE_CREATE` and
 * `INTERACTION_CREATE` only. The legacy listener also handles
 * GUILD_CREATE / THREAD_* for thread-rejoin and slash-command
 * registration — those belong to a Sprint 4 shared helper, not the
 * Bus adapter, which receives its routing from settings rather than
 * discovery.
 */
import type {
  DiscordGatewayLike,
  DiscordInboundMessage,
  DiscordInboundInteraction,
  GatewayEvent,
} from "./types";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

const Op = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

// GUILDS | GUILD_MESSAGES | GUILD_MESSAGE_REACTIONS | DIRECT_MESSAGES | MESSAGE_CONTENT
const DEFAULT_INTENTS = (1 << 0) | (1 << 9) | (1 << 10) | (1 << 12) | (1 << 15);

// Auth / sharding / intent failures Discord says are unrecoverable.
const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

interface GatewayPayload {
  op: number;
  // biome-ignore lint/suspicious/noExplicitAny: dispatch payloads vary by event
  d: any;
  s: number | null;
  t: string | null;
}

export interface DiscordGatewayOptions {
  token: string;
  /** Override the gateway intents bitfield. Defaults to the legacy listener's set. */
  intents?: number;
  /** Logger. Defaults to `console`. */
  logger?: Pick<Console, "warn" | "info" | "error">;
  /**
   * WebSocket constructor — overridable so tests can inject a fake. Defaults
   * to the global `WebSocket` (Bun + modern Node both provide it).
   */
  webSocketCtor?: typeof WebSocket;
}

export class DiscordGateway implements DiscordGatewayLike {
  private readonly token: string;
  private readonly intents: number;
  private readonly logger: Pick<Console, "warn" | "info" | "error">;
  private readonly WS: typeof WebSocket;

  private ws: WebSocket | null = null;
  private running = false;

  private heartbeatIntervalMs = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatJitterTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatAcked = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private lastSequence: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;

  private handlers: Array<(e: GatewayEvent) => void> = [];

  constructor(opts: DiscordGatewayOptions) {
    if (!opts.token) throw new Error("DiscordGateway: `token` is required");
    this.token = opts.token;
    this.intents = opts.intents ?? DEFAULT_INTENTS;
    this.logger = opts.logger ?? console;
    const Ctor = opts.webSocketCtor ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!Ctor) {
      throw new Error(
        "DiscordGateway: no WebSocket implementation available (pass `webSocketCtor` or run on a runtime with global WebSocket)",
      );
    }
    this.WS = Ctor;
  }

  /* ─────────────────────────────── DiscordGatewayLike ────────────────── */

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.connect(GATEWAY_URL);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, "Gateway stop requested");
      } catch {
        /* best-effort */
      }
      this.ws = null;
    }
    this.resetState();
    this.handlers = [];
  }

  onEvent(handler: (e: GatewayEvent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /* ─────────────────────────────── internals ─────────────────────────── */

  private emit(event: GatewayEvent): void {
    for (const h of this.handlers) {
      try {
        h(event);
      } catch (err) {
        this.logger.error("[discord-gateway] handler threw", err);
      }
    }
  }

  private sendWs(data: unknown): void {
    if (this.ws?.readyState === 1 /* WebSocket.OPEN */) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private sendHeartbeat(): void {
    this.sendWs({ op: Op.HEARTBEAT, d: this.lastSequence });
    this.heartbeatAcked = false;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    // Per Discord spec: jitter the first heartbeat between 0 and the interval.
    this.heartbeatJitterTimer = setTimeout(() => {
      this.heartbeatJitterTimer = null;
      this.sendHeartbeat();
    }, Math.random() * this.heartbeatIntervalMs);
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAcked) {
        this.logger.warn("[discord-gateway] heartbeat not acked — reconnecting");
        try {
          this.ws?.close(4000, "Heartbeat timeout");
        } catch {
          /* close errors are non-fatal */
        }
        return;
      }
      this.sendHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.heartbeatJitterTimer) clearTimeout(this.heartbeatJitterTimer);
    this.heartbeatJitterTimer = null;
  }

  private resetState(): void {
    this.heartbeatIntervalMs = 0;
    this.heartbeatAcked = true;
    this.lastSequence = null;
    this.sessionId = null;
    this.resumeGatewayUrl = null;
  }

  private sendIdentify(): void {
    this.sendWs({
      op: Op.IDENTIFY,
      d: {
        token: this.token,
        intents: this.intents,
        properties: {
          os: typeof process !== "undefined" ? process.platform : "unknown",
          browser: "claudeclaw",
          device: "claudeclaw",
        },
      },
    });
  }

  private sendResume(): void {
    this.sendWs({
      op: Op.RESUME,
      d: {
        token: this.token,
        session_id: this.sessionId,
        seq: this.lastSequence,
      },
    });
  }

  private handlePayload(payload: GatewayPayload): void {
    if (payload.s !== null) this.lastSequence = payload.s;

    switch (payload.op) {
      case Op.HELLO:
        this.heartbeatIntervalMs = payload.d?.heartbeat_interval ?? 41_250;
        this.startHeartbeat();
        if (this.sessionId && this.lastSequence !== null) {
          this.sendResume();
        } else {
          this.sendIdentify();
        }
        return;

      case Op.HEARTBEAT_ACK:
        this.heartbeatAcked = true;
        return;

      case Op.HEARTBEAT:
        this.sendHeartbeat();
        return;

      case Op.RECONNECT:
        this.logger.info("[discord-gateway] op=RECONNECT — reconnecting");
        try {
          this.ws?.close(4000, "Reconnect requested");
        } catch {
          /* best-effort */
        }
        return;

      case Op.INVALID_SESSION: {
        const resumable = Boolean(payload.d);
        this.logger.info(`[discord-gateway] op=INVALID_SESSION resumable=${resumable}`);
        if (resumable && this.sessionId) {
          setTimeout(() => this.sendResume(), 1000 + Math.random() * 4000);
        } else {
          this.sessionId = null;
          this.lastSequence = null;
          try {
            this.ws?.close(4000, "Non-resumable INVALID_SESSION");
          } catch {
            /* best-effort */
          }
        }
        return;
      }

      case Op.DISPATCH:
        this.handleDispatch(payload.t ?? "", payload.d);
        return;
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: dispatch payload shapes vary per event
  private handleDispatch(eventName: string, data: any): void {
    switch (eventName) {
      case "READY":
        this.sessionId = data?.session_id ?? null;
        this.resumeGatewayUrl = data?.resume_gateway_url ?? null;
        this.logger.info(
          `[discord-gateway] READY as ${data?.user?.username ?? "?"} (${data?.user?.id ?? "?"})`,
        );
        return;

      case "RESUMED":
        this.logger.info("[discord-gateway] RESUMED");
        return;

      case "MESSAGE_CREATE":
        this.emit({ type: "MESSAGE_CREATE", message: data as DiscordInboundMessage });
        return;

      case "INTERACTION_CREATE":
        this.emit({
          type: "INTERACTION_CREATE",
          interaction: data as DiscordInboundInteraction,
        });
        return;
    }
  }

  private connect(url: string): void {
    if (!this.running) return;
    let ws: WebSocket;
    try {
      ws = new this.WS(url);
    } catch (err) {
      this.logger.error("[discord-gateway] WebSocket construction failed", err);
      this.scheduleReconnect(/* fresh */ true);
      return;
    }
    this.ws = ws;

    ws.onmessage = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(String(event.data)) as GatewayPayload;
        this.handlePayload(payload);
      } catch (err) {
        this.logger.error("[discord-gateway] failed to parse payload", err);
      }
    };

    ws.onclose = (event: CloseEvent) => {
      this.stopHeartbeat();
      if (!this.running) return;

      if (FATAL_CLOSE_CODES.has(event.code)) {
        this.logger.error(
          `[discord-gateway] fatal close code=${event.code} reason=${event.reason} — not reconnecting`,
        );
        this.running = false;
        return;
      }

      const canResume = this.sessionId !== null && this.lastSequence !== null;
      this.scheduleReconnect(!canResume);
    };

    ws.onerror = () => {
      // onclose will fire after onerror — reconnection is handled there.
    };
  }

  private scheduleReconnect(fresh: boolean): void {
    if (!this.running) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (fresh) {
      this.sessionId = null;
      this.lastSequence = null;
      this.resumeGatewayUrl = null;
    }
    const delay = fresh ? 3000 + Math.random() * 4000 : 1000 + Math.random() * 2000;
    const nextUrl = fresh ? GATEWAY_URL : this.resumeGatewayUrl || GATEWAY_URL;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(nextUrl);
    }, delay);
  }
}

/** Factory matching the wiring style used elsewhere in `src/bus/`. */
export function createDiscordGateway(opts: DiscordGatewayOptions): DiscordGateway {
  return new DiscordGateway(opts);
}
