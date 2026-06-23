/**
 * Command Code OAuth provider for omp's /login flow.
 *
 * Simplified login: opens browser to generate an API key, then tells the user
 * to add it to ~/.omp/agent/auth.json. Falls back to manual paste in the TUI
 * for the user who prefers immediate capture over editing a file.
 *
 * Authentication:
 *   Run `/login`, select Command Code — opens browser to commandcode.ai,
 *   then paste the API key when prompted, or add it directly to
 *   ~/.omp/agent/auth.json as {"apiKey": "user_..."} or {"commandcode": "user_..."}.

const STUDIO_BASE_URL = "https://commandcode.ai";
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

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

function credentialsFromApiKey(apiKey: string): OAuthCredentials {
	return {
		access: apiKey,
		refresh: apiKey,
		expires: Date.now() + TEN_YEARS_MS,
	};
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
 * Simplified login: opens the Command Code API key page in the user's browser
 * and instructs them to add their key to ~/.omp/agent/auth.json.
 *
 * If the user prefers not to edit the file, they can paste the key directly
 * when prompted.
 */
export async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const loginUrl = `${STUDIO_BASE_URL}/api-keys`;
	const instructions =
		"Generate an API key, then add it to ~/.omp/agent/auth.json as " +
		'{"commandcode": "your-api-key-here"} and re-run /login. ' +
		"Or paste the key below for immediate use.";

	await callbacks.onAuth({ url: loginUrl, instructions });

	const apiKey = await promptForApiKey(
		callbacks,
		"Paste your Command Code API key from " +
		`${STUDIO_BASE_URL}/api-keys (or press Ctrl+C to cancel): `,
	);
	if (!apiKey) throw new Error("No API key provided");
	return credentialsFromApiKey(apiKey);
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
