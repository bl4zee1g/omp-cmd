export const DEFAULT_MODELS_URL = "https://api.commandcode.ai/provider/v1/models";

const DEFAULT_MAX_OUTPUT_TOKENS = 65_536;

export interface CommandCodeModel {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringField(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string") throw new Error(`Expected ${key} to be a string`);
	return value;
}

function numberField(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (typeof value !== "number") throw new Error(`Expected ${key} to be a number`);
	return value;
}

function parseApiModel(value: unknown): { id: string; name: string; contextLength: number } {
	if (!isRecord(value)) throw new Error("Expected model entry to be an object");
	return {
		id: stringField(value, "id"),
		name: stringField(value, "name"),
		contextLength: numberField(value, "context_length"),
	};
}

export function commandCodeModelsFromApiResponse(value: unknown): readonly CommandCodeModel[] {
	if (!isRecord(value)) throw new Error("Expected models response to be an object");
	if (value.object !== "list") throw new Error("Expected models response object to be 'list'");

	const data = value.data;
	if (!Array.isArray(data)) throw new Error("Expected models response data to be an array");

	return data.map(parseApiModel).map((model) => ({
		id: model.id,
		name: `${model.name} (CC)`,
		reasoning: true,
		contextWindow: model.contextLength,
		maxTokens: Math.min(model.contextLength, DEFAULT_MAX_OUTPUT_TOKENS),
	}));
}

export async function fetchCommandCodeModels(
	options: { url?: string; fetchImpl?: typeof fetch } = {},
): Promise<readonly CommandCodeModel[]> {
	const url = options.url ?? DEFAULT_MODELS_URL;
	const fetchImpl = options.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 5000);
	try {
		const response = await fetchImpl(url, {
			headers: { accept: "application/json" },
			signal: controller.signal,
		});

		if (!response.ok) {
			throw new Error(`Failed to fetch Command Code models: ${response.status} ${response.statusText}`);
		}

		const body: unknown = await response.json();
		return commandCodeModelsFromApiResponse(body);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to fetch Command Code models: ${message}`);
	} finally {
		clearTimeout(timer);
	}
}
