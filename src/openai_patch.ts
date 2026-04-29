/*
 * This file is a patch to the openai library to add support for the reasoning parameter.
 * Once openai's official JS SDK supports sending back raw CoT, we will remove this file.
 */
import type {
	ResponseReasoningItem as OpenAIResponseReasoningItem,
	ResponseStreamEvent as OpenAIResponseStreamEvent,
	ResponseOutputRefusal,
	ResponseOutputText,
} from "openai/resources/responses/responses";

import type { ChatCompletionChunk } from "openai/resources/chat/completions";
export interface ReasoningTextContent {
	type: "reasoning_text";
	text: string;
}

export interface ReasoningSummaryTextContent {
	type: "summary_text";
	text: string;
}

export type PatchedResponseReasoningItem = OpenAIResponseReasoningItem & {
	// Raw CoT returned in reasoning item (in addition to the summary)
	content: ReasoningTextContent[];
};

interface PatchedResponseReasoningSummaryPartAddedEvent {
	type: "response.reasoning_summary_part.added";
	sequence_number: number;
	item_id: string;
	output_index: number;
	summary_index: number;
	part: ReasoningSummaryTextContent;
}

interface PatchedResponseReasoningSummaryPartDoneEvent {
	type: "response.reasoning_summary_part.done";
	sequence_number: number;
	item_id: string;
	output_index: number;
	summary_index: number;
	part: ReasoningSummaryTextContent;
}

interface PatchedResponseReasoningSummaryTextDeltaEvent {
	type: "response.reasoning_summary_text.delta";
	sequence_number: number;
	item_id: string;
	output_index: number;
	summary_index: number;
	delta: string;
}

interface PatchedResponseReasoningSummaryTextDoneEvent {
	type: "response.reasoning_summary_text.done";
	sequence_number: number;
	item_id: string;
	output_index: number;
	summary_index: number;
	text: string;
}

interface PatchedResponseReasoningTextDeltaEvent {
	type: "response.reasoning_text.delta";
	sequence_number: number;
	item_id: string;
	output_index: number;
	content_index: number;
	delta: string;
}

interface PatchedResponseReasoningTextDoneEvent {
	type: "response.reasoning_text.done";
	sequence_number: number;
	item_id: string;
	output_index: number;
	content_index: number;
	text: string;
}

export type PatchedResponseStreamEvent =
	| OpenAIResponseStreamEvent
	| PatchedResponseReasoningSummaryPartAddedEvent
	| PatchedResponseReasoningSummaryPartDoneEvent
	| PatchedResponseReasoningSummaryTextDeltaEvent
	| PatchedResponseReasoningSummaryTextDoneEvent
	| PatchedResponseReasoningTextDeltaEvent
	| PatchedResponseReasoningTextDoneEvent;

export type PatchedResponseContentPart = ResponseOutputText | ResponseOutputRefusal;

export type PatchedDeltaWithReasoning = ChatCompletionChunk.Choice.Delta & {
	reasoning?: string;
	reasoning_content?: string;
};
