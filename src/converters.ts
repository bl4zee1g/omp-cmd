import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message, Tool, ToolCall } from "@oh-my-pi/pi-ai/types";
import { isRecord, stringValue } from "./types";

// ─── Auth helpers ────────────────────────────────────────────────────────────

function defaultAuthPaths(home: string): string[] {
	return [
		path.join(home, ".commandcode", "auth.json"),
		path.join(home, ".pi", "agent", "auth.json"),
		path.join(home, ".omp", "agent", "auth.json"),
	];
}

function apiKeyFromCredentialRecord(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const record = value as Record<string, unknown>;

	if (typeof record.apiKey === "string") return record.apiKey;
	if (typeof record.accessToken === "string") return record.accessToken;
	if (typeof record.token === "string") return record.token;
	if (typeof record.commandcode === "string") return record.commandcode;
	if (typeof record.COMMANDCODE === "string") return record.COMMANDCODE;

	const first = Object.values(record)[0];
	return typeof first === "string" ? first : undefined;
}

export function getApiKey(
	options: {
		authPaths?: string[];
		homeDir?: string;
	} = {},
): string | undefined {
	const home = options.homeDir ?? os.homedir();
	const paths = options.authPaths ?? defaultAuthPaths(home);
	for (const authPath of paths) {
		if (!existsSync(authPath)) continue;
		try {
			const content = readFileSync(authPath, "utf-8");
			const parsed: unknown = JSON.parse(content);
			const apiKey = apiKeyFromCredentialRecord(parsed);
			if (apiKey && apiKey.length > 0) return apiKey;
		} catch {
			// Malformed file — skip
		}
	}
	return undefined;
}

// ─── Environment info ────────────────────────────────────────────────────────

export function getEnvironmentInfo(): string {
	return `${process.platform}-${process.arch}, Node.js ${process.version}`;
}

// ─── Schema / tool conversion ────────────────────────────────────────────────

export function toJsonSchema(schema: unknown): unknown {
	if (!isRecord(schema) || !isRecord((schema as Record<string, unknown>).def)) return schema;
	const def = (schema as Record<string, unknown>).def as Record<string, unknown>;

	if (typeof def.type === "string" && typeof def.description === "string") {
		return {
			type: def.type,
			description: def.description,
			properties: def.properties ?? {},
			required: def.required ?? [],
		};
	}

	if (typeof def.type === "string") {
		return {
			type: def.type,
			properties: def.properties ?? {},
			required: def.required ?? [],
		};
	}

	return schema;
}

export function toolsToJson(tools?: readonly Tool[]): unknown[] {
	if (!tools || tools.length === 0) return [];

	return tools.map((tool) => ({
		name: tool.name as string,
		input_schema: toJsonSchema(tool.parameters),
		description: tool.description ?? "",
	}));
}

// ─── Message conversion ──────────────────────────────────────────────────────

function completeToolCallIds(messages?: readonly Message[]): Set<string> {
	const ids = new Set<string>();
	if (!messages) return ids;

	for (const msg of messages) {
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block && typeof block === "object" && "type" in block && block.type === "toolCall") {
					ids.add((block as ToolCall).id);
				}
			}
		}
	}
	return ids;
}

export function messagesToCC(messages?: readonly Message[]): unknown[] {
	if (!messages || messages.length === 0) return [];

	const toolCallIds = completeToolCallIds(messages);
	const result: unknown[] = [];

	for (const msg of messages) {
		switch (msg.role) {
			case "user": {
				const content = typeof msg.content === "string" ? msg.content : extractTextFromContent(msg.content);
				result.push({ role: "user", content });
				break;
			}
			case "developer":
			case "system": {
				const content = typeof msg.content === "string" ? msg.content : extractTextFromContent(msg.content);
				if (content) result.push({ role: "user", content });
				break;
			}
		case "assistant": {
			const blocks = Array.isArray(msg.content) ? msg.content : [];
			const contentBlocks: unknown[] = [];

			for (const block of blocks) {
				if (!block || typeof block !== "object") continue;
				const b = block as Record<string, unknown>;

				if (b.type === "text" && typeof b.text === "string") {
					contentBlocks.push({ type: "text", text: b.text });
				} else if (b.type === "thinking" && typeof b.thinking === "string") {
					contentBlocks.push({ type: "reasoning", text: b.thinking });
				} else if (b.type === "toolCall" && typeof b.id === "string" && typeof b.name === "string") {
					contentBlocks.push({
						type: "tool-call",
						toolCallId: b.id,
						toolName: b.name,
						input: isRecord(b.arguments) ? (b.arguments as Record<string, unknown>) : {},
					});
				}
			}

			const entry: Record<string, unknown> = { role: "assistant" };
			if (contentBlocks.length === 1 && (contentBlocks[0] as Record<string, unknown>).type === "text") {
				entry.content = (contentBlocks[0] as Record<string, unknown>).text as string;
			} else if (contentBlocks.length > 0) {
				entry.content = contentBlocks;
			} else {
				entry.content = "";
			}
			result.push(entry);
			break;
		}
		case "toolResult": {
			const toolResult = msg as {
				role: "toolResult";
				toolCallId: string;
				toolName: string;
				content: string | unknown[];
				isError: boolean;
			};
			const textContent =
				typeof toolResult.content === "string"
					? toolResult.content
					: extractTextFromContent(toolResult.content);

			result.push({
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: toolResult.toolCallId,
						toolName: toolResult.toolName,
						output: toolResult.isError
							? { type: "error-text", value: textContent }
							: { type: "text", value: textContent },
					},
				],
			});
			break;
		}
		}
	}

	return result;
}

function extractTextFromContent(content: string | unknown[]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.filter((block): block is Record<string, unknown> => isRecord(block))
		.filter((block) => block.type === "text")
		.map((block) => (typeof block.text === "string" ? block.text : ""))
		.join("");
}

// ─── System prompt ───────────────────────────────────────────────────────────

function promptPartToText(value: unknown, depth = 0): string {
	if (depth > 10) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((v) => promptPartToText(v, depth + 1)).join("\n");
	if (isRecord(value)) {
		const record = value as Record<string, unknown>;
		if (typeof record.text === "string") return record.text;
		if (typeof record.content === "string") return record.content;
		if (typeof record.type === "string" && record.type === "text" && typeof record.text === "string") {
			return record.text;
		}
	}
	return "";
}

export function systemPromptToText(value: unknown): string {
	if (Array.isArray(value)) {
		return value.map((v) => promptPartToText(v)).join("\n\n");
	}
	if (typeof value === "string") return value;
	return promptPartToText(value);
}

// ─── Stream parsing ──────────────────────────────────────────────────────────

export function parseStreamEventLine(line: string): unknown | undefined {
	const trimmed = line.trim();
	if (!trimmed || trimmed === "[DONE]") return undefined;

	// SSE format: "data: {...}"
	if (trimmed.startsWith("data:")) {
		const json = trimmed.slice(5).trim();
		if (!json) return undefined;
		try {
			return JSON.parse(json);
		} catch {
			return undefined;
		}
	}

	// Raw JSON line format (used by newer API versions)
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}


// ─── Project slug ────────────────────────────────────────────────────────────

export function projectSlugFromPath(pathName: string): string {
	return path
		.basename(pathName)
		.replace(/[^a-zA-Z0-9_-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase()
		.slice(0, 100);
}
