/**
 * Reduced port of packages/stats/src/server.ts — dashboard JSON APIs on
 * Bun.serve. No embedded web client, no port-conflict takeover logic.
 */
import {
	getDashboardStats,
	getErrorsForApi,
	getFolderStats,
	getToolDashboardStats,
	getTotalMessageCount,
	syncAllSessions,
} from "./aggregator";

export interface StatsServerArgs {
	port: number;
	host: string;
}

/**
 * Route a dashboard API request without binding a socket — tests drive this
 * directly; Bun.serve delegates to it.
 */
export async function handleApi(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const range = url.searchParams.get("range");
	const limitParam = url.searchParams.get("limit");
	const limit = limitParam !== null && Number.isFinite(Number(limitParam)) ? Number(limitParam) : 50;
	switch (url.pathname) {
		case "/api/stats":
			return Response.json(await getDashboardStats(range));
		case "/api/stats/overview":
			return Response.json(await getDashboardStats(range));
		case "/api/stats/models":
			return Response.json({ byModel: (await getDashboardStats(range)).byModel });
		case "/api/stats/folders":
			return Response.json(await getFolderStats(range));
		case "/api/stats/tools":
			return Response.json(await getToolDashboardStats(range));
		case "/api/stats/errors":
			return Response.json(await getErrorsForApi(limit, range));
		case "/api/stats/count":
			return Response.json({ total: await getTotalMessageCount() });
		case "/api/sync":
			return Response.json(await syncAllSessions());
		default:
			return new Response("not found", { status: 404 });
	}
}

/** Start the dashboard API server; resolves with the Bun server handle. */
export function startServer(args: StatsServerArgs) {
	return Bun.serve({ port: args.port, hostname: args.host, fetch: handleApi });
}

/** Human-facing dashboard URL, IPv6-aware. */
export function formatStatsDashboardUrl(host: string, port: number): string {
	const isIPv6 = host.includes(":");
	const hostname = isIPv6 ? `[${host}]` : host === "0.0.0.0" ? "localhost" : host;
	return `http://${hostname}:${port}`;
}
