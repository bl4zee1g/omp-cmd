import type {
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { getApiKey, getEnvironmentInfo, messagesToCC, parseStreamEventLine, projectSlugFromPath, systemPromptToText, toolsToJson } from "./converters";
import { isRecord, numberValue, stringValue } from "./types";

export const DEFAULT_API_BASE = "https://api.commandcode.ai";
export const COMMAND_CODE_CLI_VERSION = "0.40.0";

const DEFAULT_GENERATE_MAX_TOKENS = 64_000;
const DEFAULT_MAX_RETRIES = 0;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const BASE_RETRY_DELAY_MS = 500;

function isRetryableStatus(status: number): boolean {
	return status === 429 || (status >= 500 && status < 600);
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
	if (!value) return undefined;
	const parsed = Number(value);
	if (Number.isFinite(parsed)) return parsed;

	const match = /^(\d+)\s*$/u.exec(value);
	return match ? Number(match[1]) : undefined;
}

function effectiveMaxRetryDelayMs(value: number | undefined): number {
	if (value === undefined) return DEFAULT_MAX_RETRY_DELAY_MS;
	return Math.max(0, value);
}

function retryDelayMs(attempt: number, retryAfterHeader: string | null, maxDelayMs: number): number {
	if (maxDelayMs <= 0) return -1;

	const requested = parseRetryAfterSeconds(retryAfterHeader);
	if (requested !== undefined) {
		const ms = requested * 1000;
		return ms > maxDelayMs ? -1 : ms;
	}

	return Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, attempt), maxDelayMs);
}

function defaultUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

function abortError(message = "The operation was aborted"): DOMException {
	return new DOMException(message, "AbortError");
}

function timeoutError(timeoutMs: number | undefined): Error {
	return new Error(`Request timed out after ${timeoutMs}ms`);
}

function successStopReason(reason: StopReason): Extract<StopReason, "stop" | "length" | "toolUse"> {
	if (reason === "stop" || reason === "length" || reason === "toolUse") return reason;
	return "stop";
}

function generateMaxTokens(model: Model): number {
	const max = model.maxTokens ?? DEFAULT_GENERATE_MAX_TOKENS;
	return Math.min(max, DEFAULT_GENERATE_MAX_TOKENS);
}

function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	headers.forEach((value, key) => { result[key] = value; });
	return result;
}

function commandCodeUsage(event: Record<string, unknown>): Record<string, unknown> | undefined {
	return isRecord(event.totalUsage) ? (event.totalUsage as Record<string, unknown>) : undefined;
}

function commandCodeInputTokenDetails(usage: Record<string, unknown>): Record<string, unknown> | undefined {
	return isRecord(usage.inputTokenDetails) ? (usage.inputTokenDetails as Record<string, unknown>) : undefined;
}

export function streamCommandCode(
	model: Model,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();

	run().catch((error: unknown) => {
		const msg: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: defaultUsage(),
			stopReason: "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		};
		stream.push({ type: "error", reason: "error", error: msg });
		stream.end();
	});

	return stream;

	async function run(): Promise<void> {
		const apiBase = model.baseUrl || DEFAULT_API_BASE;
		const now = Date.now;

		const PREFIXES = ["$COMMANDCODE_API_KEY", "COMMANDCODE_API_KEY"];
		const hostKey = options?.apiKey && !PREFIXES.includes(options.apiKey as string)
			? (options.apiKey as string)
			: undefined;

		const apiKey = hostKey ?? getApiKey();
		if (!apiKey) {
			const msg: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: defaultUsage(),
				stopReason: "error",
				errorMessage:
					"No Command Code API key. Run /login and select Command Code, set the COMMANDCODE_API_KEY env var, or configure ~/.commandcode/auth.json, ~/.pi/agent/auth.json or ~/.omp/agent/auth.json",
				timestamp: now(),
			};
			stream.push({ type: "error", reason: "error", error: msg });
			stream.end();
			return;
		}

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: defaultUsage(),
			stopReason: "stop",
			timestamp: now(),
		};

		const controller = new AbortController();
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let textBlock: TextContent | undefined;
		let currentTextIdx = -1;
		let thinkingIdx = -1;
		let finished = false;

		const abortUpstream = () => {
			if (!controller.signal.aborted) controller.abort();
			try { reader?.cancel().catch(() => undefined); } catch { /* best-effort */ }
		};

		if (options?.signal?.aborted) {
			abortUpstream();
		} else {
			options?.signal?.addEventListener("abort", abortUpstream, { once: true });
		}

		const endTextBlock = () => {
			if (!textBlock) return;
			stream.push({ type: "text_end", contentIndex: currentTextIdx, content: textBlock.text, partial: output });
			textBlock = undefined;
			currentTextIdx = -1;
		};

		const endThinking = () => {
			if (thinkingIdx < 0) return;
			const tc = output.content[thinkingIdx];
			if (tc && tc.type === "thinking") {
				stream.push({ type: "thinking_end", contentIndex: thinkingIdx, content: (tc as ThinkingContent).thinking, partial: output });
			}
			thinkingIdx = -1;
		};

		const handleEvent = (event: unknown) => {
			if (!isRecord(event)) return;

			switch (event.type) {
				case "text-delta": {
					endThinking();
					if (!textBlock) {
						textBlock = { type: "text", text: "" };
						output.content.push(textBlock);
						currentTextIdx = output.content.length - 1;
						stream.push({ type: "text_start", contentIndex: currentTextIdx, partial: output });
					}
					const delta = stringValue(event.text) ?? "";
					textBlock.text += delta;
					stream.push({ type: "text_delta", contentIndex: currentTextIdx, delta, partial: output });
					break;
				}
				case "reasoning-start": {
					endTextBlock();
					break;
				}
				case "reasoning-delta": {
					endTextBlock();
					const delta = stringValue(event.text) ?? "";
					if (thinkingIdx < 0) {
						const tc: ThinkingContent = { type: "thinking", thinking: delta };
						output.content.push(tc);
						thinkingIdx = output.content.length - 1;
						stream.push({ type: "thinking_start", contentIndex: thinkingIdx, partial: output });
					} else {
						const tc = output.content[thinkingIdx];
						if (tc && tc.type === "thinking") {
							(tc as ThinkingContent).thinking += delta;
						}
					}
					stream.push({ type: "thinking_delta", contentIndex: thinkingIdx, delta, partial: output });
					break;
				}
				case "reasoning-end": {
					endThinking();
					break;
				}
				case "tool-call": {
					endTextBlock();
					endThinking();
					const toolCall: ToolCall = {
						type: "toolCall",
						id: stringValue(event.toolCallId) ?? "",
						name: stringValue(event.toolName) ?? "",
						arguments: isRecord(event.input ?? event.args ?? event.arguments)
							? (event.input ?? event.args ?? event.arguments) as Record<string, unknown>
							: {},
					};
					output.content.push(toolCall);
					const idx = output.content.length - 1;
					stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
					stream.push({ type: "toolcall_end", contentIndex: idx, toolCall, partial: output });
					break;
				}
				case "finish": {
					const usage = commandCodeUsage(event);
					if (usage) {
						const details = commandCodeInputTokenDetails(usage);
						output.usage.input = numberValue(usage.inputTokens as unknown) ?? 0;
						output.usage.output = numberValue(usage.outputTokens as unknown) ?? 0;
						output.usage.cacheRead = numberValue(details?.cacheReadTokens as unknown) ?? 0;
						output.usage.cacheWrite = numberValue(details?.cacheWriteTokens as unknown) ?? 0;
						output.usage.totalTokens =
							output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
						output.usage.cost = {
							input: (model.cost.input / 1_000_000) * output.usage.input,
							output: (model.cost.output / 1_000_000) * output.usage.output,
							cacheRead: (model.cost.cacheRead / 1_000_000) * output.usage.cacheRead,
							cacheWrite: (model.cost.cacheWrite / 1_000_000) * output.usage.cacheWrite,
							total: 0,
						};
						output.usage.cost.total =
							output.usage.cost.input + output.usage.cost.output + output.usage.cost.cacheRead + output.usage.cost.cacheWrite;
					}
					output.stopReason = mapFinishReason(event.finishReason as string | undefined);
					finished = true;
					break;
				}
				case "error": {
					const errorRecord = isRecord(event.error) ? event.error as Record<string, unknown> : undefined;
					const message = stringValue(errorRecord?.message) ?? stringValue(event.error) ?? "Stream error";
					output.stopReason = "error";
					output.errorMessage = message;
					throw new Error(message);
				}
			}
		};

		try {
			stream.push({ type: "start", partial: output });

			const workingDir = process.cwd();
			const threadId = crypto.randomUUID();

			let body: unknown = {
				config: {
					workingDir,
					date: new Date(now()).toISOString().split("T")[0],
					environment: getEnvironmentInfo(),
					structure: [],
					isGitRepo: false,
					currentBranch: "",
					mainBranch: "",
					gitStatus: "",
					recentCommits: [],
				},
				memory: null,
				taste: null,
				skills: null,
				permissionMode: "standard",
				params: {
					model: model.id.replace(/^cc\//, ""),
					messages: messagesToCC(context.messages),
					tools: toolsToJson(context.tools),
					system: systemPromptToText(context.systemPrompt),
					max_tokens: 64_000,
					stream: true,
				},
			};

			const maxRetries = DEFAULT_MAX_RETRIES;
			const maxRetryDelayMs = effectiveMaxRetryDelayMs(undefined);
			const timeoutMs = options?.timeoutMs as number | undefined;
			const requestHeaders: Record<string, string> = {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
				"x-command-code-version": COMMAND_CODE_CLI_VERSION,
				"x-cli-environment": "production",
				"x-project-slug": projectSlugFromPath(workingDir),
				"x-taste-learning": "true",
				"x-co-flag": "false",
				...(options?.headers as Record<string, string> | undefined),
			};
			const bodyStr = JSON.stringify(body);

			let response!: Response;
			retryLoop: for (let attempt = 0; ; attempt++) {
				const attemptController = new AbortController();
				let attemptTimedOut = false;
				let attemptTimeoutId: ReturnType<typeof setTimeout> | undefined;

				const clearAttemptTimeout = () => {
					if (attemptTimeoutId !== undefined) {
						clearTimeout(attemptTimeoutId);
						attemptTimeoutId = undefined;
					}
				};

				if (timeoutMs !== undefined) {
					attemptTimeoutId = setTimeout(() => {
						attemptTimedOut = true;
						attemptController.abort();
					}, timeoutMs);
				}

				const onOuterAbort = () => attemptController.abort();
				controller.signal.addEventListener("abort", onOuterAbort, { once: true });

				try {
					try {
						response = await fetch(`${apiBase}/alpha/generate`, {
							method: "POST",
							headers: requestHeaders,
							body: bodyStr,
							signal: attemptController.signal,
						});
					} catch (fetchError: unknown) {
						if (controller.signal.aborted) throw abortError("Aborted");
						if (attemptTimedOut) {
							if (attempt < maxRetries) continue retryLoop;
							throw timeoutError(timeoutMs);
						}
						throw fetchError;
					}

					// HTTP-level retry
					if (!response.ok && isRetryableStatus(response.status)) {
						const retryAfter = response.headers.get("retry-after");
						const waitMs = retryDelayMs(attempt, retryAfter, maxRetryDelayMs);
						if (waitMs < 0) {
							const requestedSeconds = parseRetryAfterSeconds(retryAfter) ?? 0;
							throw new Error(`Retry-After delay ${requestedSeconds}s exceeds max ${maxRetryDelayMs}ms`);
						}
						if (attempt < maxRetries) {
							await response.text().catch(() => "");
							if (waitMs > 0) await sleep(waitMs, controller.signal);
							continue retryLoop;
						}
					}

					if (!response.ok) {
						const errBody = await response.text().catch(() => "");
						throw new Error(`Command Code API error ${response.status}: ${errBody.slice(0, 500)}`);
					}

					// Read response stream
					reader = response.body?.getReader();
					if (!reader) throw new Error("No response body");

					const decoder = new TextDecoder();
					let buffer = "";

					try {
						readLoop: for (;;) {
							if (controller.signal.aborted) throw abortError("Aborted");
							const { done, value } = await reader.read();
							if (done) {
								if (buffer.trim()) handleEvent(parseStreamEventLine(buffer));
								break;
							}

							buffer += decoder.decode(value, { stream: true });
							const lines = buffer.split("\n");
							buffer = lines.pop() ?? "";

							for (const line of lines) {
								if (controller.signal.aborted) throw abortError("Aborted");
								handleEvent(parseStreamEventLine(line));
								if (finished) break readLoop;
							}
						}
					} catch (streamError: unknown) {
						await reader.cancel().catch(() => {});
						try { reader.releaseLock(); } catch { /* already released */ }
						reader = undefined;

						if (controller.signal.aborted) throw streamError;

						const canRetry = output.content.length === 0 && attempt < maxRetries;
						if (canRetry) {
							output.content.length = 0;
							textBlock = undefined;
							currentTextIdx = -1;
							thinkingIdx = -1;
							output.stopReason = "stop";
							output.errorMessage = undefined;
							finished = false;
							const waitMs = attemptTimedOut ? 0 : retryDelayMs(attempt, null, maxRetryDelayMs);
							if (waitMs > 0) await sleep(waitMs, controller.signal);
							continue retryLoop;
						}
						if (attemptTimedOut) throw timeoutError(timeoutMs);
						throw streamError;
					}

					// Stream completed successfully
					endTextBlock();
					endThinking();

					stream.push({
						type: "done",
						reason: successStopReason(output.stopReason),
						message: output,
					});
					stream.end();
					break retryLoop;
				} finally {
					controller.signal.removeEventListener("abort", onOuterAbort);
					clearAttemptTimeout();
				}
			}
		} catch (error: unknown) {
			const reason: StopReason = controller.signal.aborted ? "aborted" : "error";
			output.stopReason = reason;
			output.errorMessage = reason === "aborted"
				? "Request aborted"
				: error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: reason === "aborted" ? "aborted" : "error", error: output });
			stream.end();
		} finally {
			options?.signal?.removeEventListener("abort", abortUpstream);
			try { await reader?.cancel(); } catch { /* already done */ }
			try { reader?.releaseLock(); } catch { /* already released */ }
		}
	}
}

function mapFinishReason(reason: string | undefined): StopReason {
	switch (reason) {
		case "stop":
		case "end_turn":
			return "stop";
		case "length":
		case "max_tokens":
			return "length";
		case "tool_calls":
		case "tool_use":
			return "toolUse";
		default:
			return "stop";
	}
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(abortError());
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const id = setTimeout(() => {
		signal.removeEventListener("abort", onAbort);
		resolve();
	}, ms);
	const onAbort = () => {
		clearTimeout(id);
		reject(abortError());
	};
	signal.addEventListener("abort", onAbort, { once: true });
	return promise;
}
