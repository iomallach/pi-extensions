import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

import { withEditedContent } from "./proposals.js";
import type { GateProposal, ReviewOutcome } from "./types.js";
import { buildWebUiHtml } from "./web-ui.js";

// ── Serialized shape sent to the browser ─────────────────────────────────────

type SerializedProposal = Pick<
  GateProposal,
  "toolName" | "path" | "language" | "originalContent" | "nextContent" | "diff" | "reason"
>;

type DecisionPayload =
  | { kind: "approve"; nextContent: string }
  | { kind: "steer"; feedback: string }
  | { kind: "deny" }
  | { kind: "cancel" };

function serializeProposal(p: GateProposal): SerializedProposal {
  return {
    toolName: p.toolName,
    path: p.path,
    language: p.language,
    originalContent: p.originalContent,
    nextContent: p.nextContent,
    diff: p.diff,
    reason: p.reason,
  };
}

function payloadToOutcome(payload: DecisionPayload, proposal: GateProposal): ReviewOutcome {
  if (payload.kind === "approve") {
    const next = payload.nextContent;
    return next !== proposal.nextContent
      ? { kind: "approve", proposal: withEditedContent(proposal, next) }
      : { kind: "approve", proposal };
  }
  if (payload.kind === "steer") return { kind: "steer", feedback: payload.feedback };
  if (payload.kind === "deny") return { kind: "deny" };
  return { kind: "cancel" };
}

// ── Browser open helper ──────────────────────────────────────────────────────

function openUrl(url: string): void {
  const [cmd, ...args] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  spawn(cmd!, args, { detached: true, stdio: "ignore" }).unref();
}

// ── Server ───────────────────────────────────────────────────────────────────

type PendingReview = {
  proposal: GateProposal;
  resolve: (outcome: ReviewOutcome) => void;
};

export class EditgateServer {
  private server: Server | null = null;
  private _port = 0;
  private pending: PendingReview | null = null;
  private sseClients = new Set<ServerResponse>();
  private browserOpened = false;

  get port(): number {
    return this._port;
  }

  get url(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  get isRunning(): boolean {
    return this.server !== null;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.browserOpened = false;
    const srv = createServer((req, res) => this.handleRequest(req, res));
    await new Promise<void>((resolve, reject) => {
      srv.listen(0, "127.0.0.1", resolve);
      srv.once("error", reject);
    });
    const addr = srv.address();
    this._port = typeof addr === "object" && addr !== null ? addr.port : 0;
    this.server = srv;
  }

  async stop(): Promise<void> {
    const srv = this.server;
    if (!srv) return;

    if (this.pending) {
      this.pending.resolve({ kind: "cancel" });
      this.pending = null;
    }

    for (const client of this.sseClients) {
      try {
        client.destroy();
      } catch {
        /* ignore */
      }
    }
    this.sseClients.clear();

    this.server = null;
    this._port = 0;
    this.browserOpened = false;

    srv.closeAllConnections();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  /**
   * Block the current tool_call handler until the user makes a decision in the
   * browser.  Returns a ReviewOutcome that mirrors what showReviewUi() returns.
   */
  async awaitDecision(proposal: GateProposal): Promise<ReviewOutcome> {
    if (!this.isRunning) return { kind: "approve", proposal };

    // Cancel any orphaned review from a previous call.
    if (this.pending) {
      this.pending.resolve({ kind: "cancel" });
    }

    const promise = new Promise<ReviewOutcome>((resolve) => {
      this.pending = { proposal, resolve };
    });

    // Push new proposal to browsers that are already open.
    this.broadcastProposal();

    // Open the browser if no SSE client is connected (first call, or user
    // closed the tab between proposals).
    if (this.sseClients.size === 0) {
      openUrl(this.url);
      this.browserOpened = true;
    }

    return promise;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private broadcastProposal(): void {
    if (!this.pending) return;
    const data = JSON.stringify(serializeProposal(this.pending.proposal));
    for (const client of this.sseClients) {
      try {
        client.write(`event: proposal\ndata: ${data}\n\n`);
      } catch {
        /* ignore broken pipe */
      }
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this._port}`);
    res.setHeader("Access-Control-Allow-Origin", "*");

    // ── GET / → serve the web UI ────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(buildWebUiHtml());
      return;
    }

    // ── GET /api/proposal → current proposal JSON ───────────────────────────
    if (req.method === "GET" && url.pathname === "/api/proposal") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.pending ? serializeProposal(this.pending.proposal) : null));
      return;
    }

    // ── GET /api/events → SSE stream ────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");

      // Send the current proposal immediately so the browser doesn't need a
      // separate /api/proposal fetch after connecting.
      if (this.pending) {
        const data = JSON.stringify(serializeProposal(this.pending.proposal));
        res.write(`event: proposal\ndata: ${data}\n\n`);
      }

      this.sseClients.add(res);
      req.on("close", () => this.sseClients.delete(res));
      return;
    }

    // ── OPTIONS /api/decision → CORS preflight ──────────────────────────────
    if (req.method === "OPTIONS" && url.pathname === "/api/decision") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    // ── POST /api/decision → receive user decision ──────────────────────────
    if (req.method === "POST" && url.pathname === "/api/decision") {
      let body = "";
      req.on("data", (chunk: Buffer | string) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        if (!this.pending) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No pending review" }));
          return;
        }
        try {
          const payload = JSON.parse(body) as DecisionPayload;
          const outcome = payloadToOutcome(payload, this.pending.proposal);
          const { resolve } = this.pending;
          this.pending = null;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          resolve(outcome);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid payload" }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  }
}
