import type { ApiChatCompletionRequest } from '$lib/types/api';

const CONTEXT_OS_BRIDGE_URL = 'http://127.0.0.1:8181/v1/context/prepare';

interface ContextOsBridgeResponse {
	schemaVersion: 1;
	status: 'UNCHANGED' | 'PREPARED';
	messages: ApiChatCompletionRequest['messages'];
	report: {
		initialTokens: number;
		finalTokens: number;
		initialRatio: number;
		finalRatio: number;
		actions: string[];
		failure: boolean;
	};
	cacheHit: boolean;
}

export class ContextOsBridgeService {
	static async prepare(
		requestBody: ApiChatCompletionRequest,
		conversationId: string,
		signal?: AbortSignal
	): Promise<ContextOsBridgeResponse> {
		const requestedMax = requestBody.max_tokens;
		const response = await fetch(CONTEXT_OS_BRIDGE_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				schemaVersion: 1,
				conversationId,
				messages: requestBody.messages,
				tools: requestBody.tools ?? [],
				maxOutputTokens:
					typeof requestedMax === 'number' && requestedMax > 0 ? requestedMax : undefined
			}),
			signal
		});
		const text = await response.text();
		let body: ContextOsBridgeResponse | { error?: string };
		try {
			body = text ? JSON.parse(text) : {};
		} catch {
			throw new Error(`ContextOS Host Bridge returned invalid JSON (${response.status})`);
		}
		if (!response.ok) {
			const detail = 'error' in body && body.error ? body.error : response.statusText;
			throw new Error(`ContextOS blocked an unsafe model request: ${detail}`);
		}
		const result = body as ContextOsBridgeResponse;
		if (result.schemaVersion !== 1 || !Array.isArray(result.messages) || result.report?.failure) {
			throw new Error('ContextOS Host Bridge returned an invalid preparation result');
		}
		return result;
	}
}
