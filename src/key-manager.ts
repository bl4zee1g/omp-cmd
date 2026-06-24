/**
 * Multi-key manager for Command Code API keys.
 * 
 * Supports multiple API keys in auth.json with automatic rotation
 * when a key runs out of credits.
 * 
 * Auth.json formats:
 *   - Single key: {"commandcode": "user_..."}
 *   - Array of keys: {"commandcode": ["user_1...", "user_2..."]}
 *   - apiKey variants: {"apiKey": "user_..."} or {"apiKey": ["user_1...", "user_2..."]}
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AUTH_JSON_PATH = join(homedir(), ".omp", "agent", "auth.json");
const PLACEHOLDER = "user_xxxxxxxxxxxx";

// Keys that have run out of credits (in-memory only, not persisted)
const exhaustedKeys = new Set<string>();

/**
 * Ensure ~/.omp/agent/auth.json exists.
 */
export function createAuthJsonIfMissing(): void {
	const dir = join(homedir(), ".omp", "agent");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	if (!existsSync(AUTH_JSON_PATH)) {
		const template = JSON.stringify({ commandcode: PLACEHOLDER }, null, 2) + "\n";
		writeFileSync(AUTH_JSON_PATH, template, { mode: 0o600 });
	}
}

/**
 * Read all valid API keys from auth.json.
 * Returns an array of keys (may be empty if none configured).
 */
export function readAllApiKeys(): string[] {
	try {
		const raw = readFileSync(AUTH_JSON_PATH, "utf-8");
		const data: Record<string, unknown> = JSON.parse(raw);
		
		// Try commandcode field first, then apiKey
		const value = data.commandcode ?? data.apiKey;
		
		if (typeof value === "string") {
			// Single key
			return value !== PLACEHOLDER ? [value] : [];
		}
		
		if (Array.isArray(value)) {
			// Array of keys
			return value.filter((k): k is string => 
				typeof k === "string" && k !== PLACEHOLDER
			);
		}
	} catch {
		// File missing or corrupt
	}
	return [];
}

/**
 * Get the next available API key (not exhausted).
 * Returns undefined if all keys are exhausted.
 */
export function getNextAvailableKey(): string | undefined {
	const allKeys = readAllApiKeys();
	
	// Find first key that hasn't been marked as exhausted
	for (const key of allKeys) {
		if (!exhaustedKeys.has(key)) {
			return key;
		}
	}
	
	return undefined;
}

/**
 * Mark a key as exhausted (out of credits).
 */
export function markKeyExhausted(apiKey: string): void {
	exhaustedKeys.add(apiKey);
}

/**
 * Reset all exhaustion marks (e.g., after a while or on explicit refresh).
 */
export function resetExhaustedKeys(): void {
	exhaustedKeys.clear();
}

/**
 * Get the count of available (non-exhausted) keys.
 */
export function getAvailableKeyCount(): number {
	const allKeys = readAllApiKeys();
	return allKeys.filter(k => !exhaustedKeys.has(k)).length;
}
