/**
 * Command Code provider for omp.
 *
 * Connects omp to Command Code's API (https://api.commandcode.ai/alpha/generate).
 *
 * Installation:
 *   omp plugin install omp-commandcode
 *
 *   or locally:
 *   omp plugin link ./path/to/omp-commandcode
 *
 * Authentication:
 *   Run `/login`, select Command Code — opens browser to commandcode.ai,
 *   Or place the key directly in ~/.omp/agent/auth.json:
 *   {"apiKey": "user_..."} or {"commandcode": "user_..."}
 * On first load, a template auth.json is auto-created at ~/.omp/agent/auth.json.
 *
 * Models are fetched from Command Code's Provider API at startup.
 */

import type { ExtensionAPI, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { streamCommandCode, DEFAULT_API_BASE, COMMAND_CODE_CLI_VERSION } from "./src/core.ts";
import { DEFAULT_MODELS_URL, fetchCommandCodeModels } from "./src/models.ts";
import { getApiKey, login, refreshToken } from "./src/oauth.ts";
import { createAuthJsonIfMissing, getNextAvailableKey } from "./src/key-manager";

interface CommandCodeModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

const ZERO_MODEL_COST: CommandCodeModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const MODEL_COSTS: Record<string, CommandCodeModelCost> = {
	"moonshotai/Kimi-K2.7-Code": { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
	"moonshotai/Kimi-K2.7-Code-Highspeed": { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 },
	"moonshotai/Kimi-K2.6": { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
	"moonshotai/Kimi-K2.5": { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
	"zai-org/GLM-5.2": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
	"zai-org/GLM-5.1": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
	"zai-org/GLM-5": { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
	"MiniMaxAI/MiniMax-M3": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
	"MiniMaxAI/MiniMax-M2.7": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
	"MiniMaxAI/MiniMax-M2.5": { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
	"deepseek/deepseek-v4-pro": { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
	"deepseek/deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
	"Qwen/Qwen3.6-Max-Preview": { input: 1.3, output: 7.8, cacheRead: 0.26, cacheWrite: 1.63 },
	"Qwen/Qwen3.6-Plus": { input: 0.5, output: 3, cacheRead: 0.1, cacheWrite: 0 },
	"Qwen/Qwen3.7-Max": { input: 1.25, output: 3.75, cacheRead: 0.25, cacheWrite: 1.56 },
	"Qwen/Qwen3.7-Plus": { input: 0.4, output: 1.6, cacheRead: 0.08, cacheWrite: 0.5 },
	"stepfun/Step-3.7-Flash": { input: 0.2, output: 1.15, cacheRead: 0.04, cacheWrite: 0 },
	"stepfun/Step-3.5-Flash": { input: 0.1, output: 0.3, cacheRead: 0.02, cacheWrite: 0 },
	"xiaomi/mimo-v2.5-pro": { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 },
	"xiaomi/mimo-v2.5": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
	"nemotron-3-ultra-550b-a55b": { input: 0.37, output: 1.08, cacheRead: 0.14, cacheWrite: 0 },
	"claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	"claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	"claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	"gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
	"gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
	"gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
	"gpt-5.3-codex": { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
	"google/gemini-3.5-flash": { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
	"google/gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cacheRead: 0.03, cacheWrite: 0 },
	"sakana/fugu-ultra": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 }
};

const API_BASE = process.env.COMMANDCODE_API_BASE ?? DEFAULT_API_BASE;
const MODELS_URL = process.env.COMMANDCODE_MODELS_URL ?? DEFAULT_MODELS_URL;


// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI): Promise<void> {
	createAuthJsonIfMissing();
	const authKey = getNextAvailableKey();

	let models: ProviderModelConfig[];
	try {
		const fetched = await fetchCommandCodeModels({ url: MODELS_URL });
		models = fetched.map((model) => ({
			id: `${model.id}`,
			name: model.name,
			reasoning: model.reasoning,
			input: ["text"] as const,
			cost: MODEL_COSTS[model.id] ?? ZERO_MODEL_COST,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		}));
	} catch {
		models = [];
	}

	pi.registerProvider("commandcode", {
		baseUrl: API_BASE,
		apiKey: authKey,
		authHeader: true,
		api: "commandcode-custom",
		streamSimple: streamCommandCode,
		headers: {
			"x-command-code-version": COMMAND_CODE_CLI_VERSION,
			"x-cli-environment": "production",
		},
		oauth: {
			name: "Command Code",
			login,
			refreshToken,
			getApiKey,
		},
		models,
	});
}

