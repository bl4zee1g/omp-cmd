/**
 * Command Code OAuth provider for omp's /login flow.
 *
 * Authentication (pick one):
 *   1. Run `/login`, then select Command Code — opens browser to commandcode.ai, auto-stores API key
 *   2. Set COMMANDCODE_API_KEY environment variable
 *   3. Place API key in ~/.commandcode/auth.json or ~/.omp/agent/auth.json
 *      as {"apiKey": "user_..."} or {"commandcode": "user_..."}
 */

import { randomBytes } from "node:crypto";
import { startAuthServer } from "./auth-server.ts";

const STUDIO_BASE_URL = "https://commandcode.ai";
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const DEFAULT_AUTH_TIMEOUT_MS = 15_000;

/**
 * OMP's OAuthLoginCallbacks type from @oh-my-pi/pi-ai/oauth/types.
 * We define it locally to avoid importing from the host package.
 */
export interface OAuthAuthInfo {
	url: string;
	instructions?: string;
}

export interface OAuthPrompt {
	message: string;
	placeholder?: string;
	allowEmpty?: boolean;
}

export interface OAuthLoginCallbacks {
	onAuth(info: OAuthAuthInfo): void | Promise<void>;
	onPrompt(prompt: OAuthPrompt): Promise<string>;
	onProgress?(message: string): void;
	signal?: AbortSignal;
}

export interface OAuthCredentials {
	access: string;
	refresh: string;
	expires: number;
}

class AuthTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthTimeoutError";
	}
}

function generateStateToken(): string {
	return randomBytes(32).toString("base64url");
}

function getAuthTimeoutMs(): number {
	const env = process.env.COMMANDCODE_AUTH_TIMEOUT_MS;
	if (env) {
		const parsed = parseInt(env, 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return DEFAULT_AUTH_TIMEOUT_MS;
}

function credentialsFromApiKey(apiKey: string): OAuthCredentials {
	return {
		access: apiKey,
		refresh: apiKey,
		expires: Date.now() + TEN_YEARS_MS,
	};
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	const { promise: timeoutPromise, reject: rejectTimeout } = Promise.withResolvers<never>();
	const id = setTimeout(() => rejectTimeout(new AuthTimeoutError("Login timed out")), timeoutMs);
	return Promise.race([
		promise.then((result) => { clearTimeout(id); return result; }),
		timeoutPromise,
	]);
}

/**
 * Remove common terminal paste wrappers/control chars and surrounding whitespace.
 */
export function sanitizeApiKey(input: string): string {
	return input
		.replace(/^[\x00-\x1f]+/u, "")
		.replace(/[\x00-\x1f]+$/u, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/gu, "")
		.trim();
}

async function promptForApiKey(callbacks: OAuthLoginCallbacks, message: string): Promise<string> {
	const input = await callbacks.onPrompt({ message });
	return sanitizeApiKey(input);
}

/**
 * Starts the browser-based login flow for Command Code.
 *
 * 1. Opens the Command Code Studio API key page in the user's browser.
 * 2. Starts a local HTTP server to receive the callback.
 * 3. If the callback fails, falls back to prompting for the API key via stdin.
 */
export async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const state = generateStateToken();
	const authServer = await startAuthServer();

	const loginUrl = `${STUDIO_BASE_URL}/api-keys?cli=true&state=${state}&port=${authServer.port}`;
	await callbacks.onAuth({ url: loginUrl });

	try {
		const callback = await withTimeout(authServer.waitForCallback, getAuthTimeoutMs());

		if (callback.state !== state) {
			throw new Error("State mismatch in OAuth callback — possible CSRF");
		}

		return credentialsFromApiKey(callback.apiKey);
	} catch (err) {
		if (err instanceof AuthTimeoutError) {
			// Fall back to manual API key entry
			const apiKey = await promptForApiKey(
				callbacks,
				"Paste your Command Code API key from " +
				`${STUDIO_BASE_URL}/api-keys (or press Ctrl+C to cancel): `,
			);
			if (!apiKey) throw new Error("No API key provided");
			return credentialsFromApiKey(apiKey);
		}
		throw err;
	}
}

/**
 * Command Code API keys don't expire, so "refresh" is a no-op.
 * Returns the same credentials with an updated far-future expiry.
 */
export async function refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	return credentialsFromApiKey(credentials.refresh);
}

/**
 * Returns the access token (API key) from OAuth credentials.
 */
export function getApiKey(credentials: OAuthCredentials): string {
	return credentials.access;
}
