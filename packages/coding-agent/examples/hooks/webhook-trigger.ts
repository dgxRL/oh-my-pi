/**
 * Webhook Trigger Hook
 *
 * Runs a small HTTP listener inside the agent process and turns POSTed JSON
 * payloads into agent turns — the inbound-event surface the DeepSeek
 * super-agent design calls Triggers (IM messages, CI results, review
 * comments...). The payload is injected as a real turn; anything the agent is
 * already doing is unaffected (idle starts a turn, streaming queues as steer).
 *
 * Usage:
 *   OMP_WEBHOOK_TOKEN=secret omp --hook examples/hooks/webhook-trigger.ts
 *
 *   curl -s localhost:7766/health
 *   curl -s -X POST localhost:7766/trigger \
 *     -H 'authorization: Bearer secret' -H 'content-type: application/json' \
 *     -d '{"message": "CI failed on main: <job url>. Investigate."}'
 *
 * Security: binds to 127.0.0.1 only. OMP_WEBHOOK_TOKEN is required — requests
 * without it are rejected before any payload is read. Expose it beyond
 * localhost only behind an authenticating proxy you trust.
 */
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

const DEFAULT_PORT = 7766;

interface WebhookPayload {
	message?: unknown;
	source?: unknown;
}

export default function (pi: HookAPI) {
	let server: Bun.Server<undefined> | undefined;

	pi.on("session_shutdown", async () => {
		server?.stop(true);
		server = undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		if (server) return; // session_start can fire again on resume — never double-bind
		const token = process.env.OMP_WEBHOOK_TOKEN;
		if (!token) {
			if (ctx.hasUI) ctx.ui.notify("webhook-trigger: OMP_WEBHOOK_TOKEN is not set; listener not started", "warning");
			return;
		}
		const port = Number(process.env.OMP_WEBHOOK_PORT) || DEFAULT_PORT;

		server = Bun.serve({
			hostname: "127.0.0.1",
			port,
			async fetch(request) {
				const url = new URL(request.url);
				if (url.pathname === "/health") {
					return new Response("ok\n");
				}
				if (request.method !== "POST" || url.pathname !== "/trigger") {
					return new Response("not found\n", { status: 404 });
				}
				const authorization = request.headers.get("authorization") ?? "";
				if (authorization !== `Bearer ${token}`) {
					return new Response("unauthorized\n", { status: 401 });
				}
				let payload: WebhookPayload;
				try {
					payload = (await request.json()) as WebhookPayload;
				} catch {
					return new Response("invalid JSON body\n", { status: 400 });
				}
				const message = typeof payload.message === "string" ? payload.message.trim() : "";
				if (!message) {
					return new Response('missing string field "message"\n', { status: 400 });
				}
				const source = typeof payload.source === "string" ? payload.source : "webhook";
				pi.sendMessage(
					{
						customType: "webhook-trigger",
						content: `External event from ${source}: ${message}`,
						display: true,
					},
					{ triggerTurn: true },
				);
				return new Response("accepted\n", { status: 202 });
			},
		});

		if (ctx.hasUI) {
			ctx.ui.notify(`webhook-trigger: listening on http://127.0.0.1:${port}/trigger`, "info");
		}
	});
}
