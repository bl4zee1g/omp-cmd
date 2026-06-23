import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const DEFAULT_PORT = 5959;
const DEFAULT_PORT_RANGE = 10;

export interface AuthCallback {
	apiKey: string;
	state: string;
	userId: string;
	userName: string;
	keyName: string;
}

export interface AuthServer {
	server: Server;
	port: number;
	waitForCallback: Promise<AuthCallback>;
}

export interface AuthServerOptions {
	startPort?: number;
	portRange?: number;
}

function listenOnAvailablePort(server: Server, startPort = DEFAULT_PORT, range = DEFAULT_PORT_RANGE): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();

	const tryPort = (port: number) => {
		server.once("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "EADDRINUSE" && port < startPort + range - 1) {
				server.removeAllListeners("error");
				tryPort(port + 1);
			} else {
				reject(err);
			}
		});
		server.listen(port, "127.0.0.1", () => {
			resolve(port);
		});
	};

	tryPort(startPort);
	return promise;
}

function closeServer(server: Server): void {
	const { promise, resolve } = Promise.withResolvers<void>();
	server.close((err: NodeJS.ErrnoException | undefined) => {
		if (err) {
			// Force close
			server.closeAllConnections?.();
		}
		resolve();
	});
}

export async function startAuthServer(options: AuthServerOptions = {}): Promise<AuthServer> {
	const { promise: waitForCallback, resolve: resolveCallback, reject: rejectCallback } = Promise.withResolvers<AuthCallback>();

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const respond = (status: number, body: string, contentType = "text/plain") => {
			res.writeHead(status, { "Content-Type": contentType });
			res.end(body);
		};

		if (req.method !== "POST" || !req.url?.startsWith("/callback")) {
			respond(404, "Not Found");
			return;
		}

		let body = "";
		req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
		req.on("end", () => {
			try {
				const data: Record<string, unknown> = JSON.parse(body);

				const apiKey = typeof data.apiKey === "string" ? data.apiKey : "";
				const state = typeof data.state === "string" ? data.state : "";
				const userId = typeof data.userId === "string" ? data.userId : "";
				const userName = typeof data.userName === "string" ? data.userName : "";
				const keyName = typeof data.keyName === "string" ? data.keyName : "";

				if (!apiKey) {
					respond(400, JSON.stringify({ error: "Missing apiKey" }));
					return;
				}

				resolveCallback({ apiKey, state, userId, userName, keyName });
				respond(200, JSON.stringify({ ok: true }), "application/json");

				// Close the server after a short delay to allow the response to be sent
				setTimeout(() => closeServer(server), 100);
			} catch (err) {
				respond(400, JSON.stringify({ error: "Invalid JSON" }), "application/json");
				rejectCallback(err);
			}
		});
	});

	const port = await listenOnAvailablePort(server, options.startPort, options.portRange);

	return { server, port, waitForCallback };
}
