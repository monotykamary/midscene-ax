import type { TModelFamily } from '@midscene/shared/env';
import type {
  BuildResponsesParams,
  ChatCompletionCallContext,
  ChatCompletionParamsResult,
  CodexAppServerCallInput,
  CodexAppServerParamsResult,
  ModelAdapterDefinition,
  ReasoningInput,
  ResolveImageDetail,
} from '../model-adapter/types';
import { isLocateIntent } from './utils/intent';

const originalImageDetailForLocateIntent: ResolveImageDetail = (input) =>
  isLocateIntent(input.intent) || input.requiresOriginalImageDetail
    ? 'original'
    : (input.imageDetail ?? 'high');

// GPT-5 reads text in assertions, queries and waits as well as locating, and
// providers such as the Codex app-server downscale any image not sent as
// 'original'. Default every intent to full resolution; an explicit per-image
// detail is still honored outside locate.
const originalImageDetailForEveryIntent: ResolveImageDetail = (input) =>
  isLocateIntent(input.intent) || input.requiresOriginalImageDetail
    ? 'original'
    : (input.imageDetail ?? 'original');

// Some OpenAI-compatible gateways stretch an image to a multiple of 32 pixels
// before the model sees it, so returned coordinates come back stretched.
// Padding to that size first keeps one image pixel per screen pixel.
const gptImagePreprocess = { padBlockSize: 32 };

const resolveGpt5ReasoningEffort = ({
  reasoningEnabled,
  reasoningEffort,
}: ReasoningInput): string | undefined => {
  if (reasoningEnabled === 'default') return undefined;
  return reasoningEnabled === true ? (reasoningEffort ?? 'medium') : 'none';
};

// Astra cannot disable reasoning; use its lowest effort when disabled.
const resolveGpt6ReasoningEffort = ({
  reasoningEnabled,
  reasoningEffort,
}: ReasoningInput): string | undefined => {
  if (reasoningEnabled === 'default') return undefined;
  return reasoningEnabled === true ? (reasoningEffort ?? 'medium') : 'low';
};

const buildGpt5CodexAppServerParams = (
  input: CodexAppServerCallInput,
): CodexAppServerParamsResult => ({
  config: { effort: resolveGpt5ReasoningEffort(input.userConfig ?? {}) },
});

const buildGpt6CodexAppServerParams = (
  input: CodexAppServerCallInput,
): CodexAppServerParamsResult => ({
  config: { effort: resolveGpt6ReasoningEffort(input.userConfig ?? {}) },
});

const buildGpt5ResponsesParams: BuildResponsesParams = (input) => {
  const { midsceneDefaults, userConfig, expectedJsonObjectResponse } = input;
  const commonOverrideConfig: Record<string, unknown> = {};

  if (userConfig.temperature !== undefined) {
    commonOverrideConfig.temperature = userConfig.temperature;
  }

  if (userConfig.responseFormat !== 'none' && expectedJsonObjectResponse) {
    commonOverrideConfig.text = { format: { type: 'json_object' } };
  }

  const effectiveReasoningEffort = resolveGpt5ReasoningEffort(userConfig);

  return {
    config: {
      ...midsceneDefaults,
      ...commonOverrideConfig,
      // Use current-turn reasoning only. Switching to all_turns requires
      // responses.replayRawAssistantOutput to preserve reasoning history.
      reasoning: { effort: effectiveReasoningEffort, context: 'current_turn' },
    },
  };
};

const buildGpt6ResponsesParams: BuildResponsesParams = (input) => {
  const { midsceneDefaults, userConfig, expectedJsonObjectResponse } = input;
  const { responseFormat } = userConfig;
  const commonOverrideConfig: Record<string, unknown> = {};
  // GPT-6 does not support temperature; omit it from the serialized request.
  commonOverrideConfig.temperature = undefined;
  if (responseFormat !== 'none' && expectedJsonObjectResponse) {
    commonOverrideConfig.text = { format: { type: 'json_object' } };
  }

  const effectiveReasoningEffort = resolveGpt6ReasoningEffort(userConfig);

  return {
    config: {
      ...midsceneDefaults,
      ...commonOverrideConfig,
      // Use current-turn reasoning only. Switching to all_turns requires
      // responses.replayRawAssistantOutput to preserve reasoning history.
      reasoning: { effort: effectiveReasoningEffort, context: 'current_turn' },
    },
  };
};

const buildGpt5ChatCompletionParams = (
  input: ChatCompletionCallContext,
): ChatCompletionParamsResult => {
  const { midsceneDefaults, userConfig } = input;
  const commonOverrideConfig: Record<string, unknown> = {};

  if (userConfig.temperature !== undefined) {
    commonOverrideConfig.temperature = userConfig.temperature;
  }

  // OpenAI Chat Completions JSON mode:
  // https://platform.openai.com/docs/guides/structured-outputs?api-mode=chat#json-mode
  if (
    input.userConfig.responseFormat !== 'none' &&
    input.expectedJsonObjectResponse
  ) {
    commonOverrideConfig.response_format = { type: 'json_object' };
  }

  const effectiveReasoningEffort = resolveGpt5ReasoningEffort(userConfig);

  return {
    config: {
      ...midsceneDefaults,
      ...commonOverrideConfig,
      reasoning_effort: effectiveReasoningEffort,
    },
  };
};

const buildGpt6ChatCompletionParams = (
  input: ChatCompletionCallContext,
): ChatCompletionParamsResult => {
  const { midsceneDefaults, userConfig, expectedJsonObjectResponse } = input;
  const { responseFormat } = userConfig;
  const commonOverrideConfig: Record<string, unknown> = {};
  // GPT-6 does not support temperature; omit it from the serialized request.
  commonOverrideConfig.temperature = undefined;
  if (responseFormat !== 'none' && expectedJsonObjectResponse) {
    commonOverrideConfig.response_format = { type: 'json_object' };
  }

  const effectiveReasoningEffort = resolveGpt6ReasoningEffort(userConfig);

  return {
    config: {
      ...midsceneDefaults,
      ...commonOverrideConfig,
      reasoning_effort: effectiveReasoningEffort,
    },
  };
};

export const gptAdapters = {
  'gpt-5': {
    supportedProtocols: ['openai-chat', 'openai-responses'],
    resolveImageDetail: originalImageDetailForEveryIntent,
    imagePreprocess: gptImagePreprocess,
    responses: {
      replayRawAssistantOutput: false,
      unsupportedUserConfig: ['reasoningBudget'],
      buildResponsesParams: buildGpt5ResponsesParams,
    },
    buildCodexAppServerParams: buildGpt5CodexAppServerParams,
    chatCompletion: {
      unsupportedUserConfig: ['reasoningBudget'],
      buildChatCompletionParams: buildGpt5ChatCompletionParams,
    },
    locate: {
      element: {
        resultFormat: {
          // GPT can return image width/height as bbox endpoints (issue #3351).
          // Accept image-edge coordinates without assuming all variants do so.
          coordinates: {
            shape: 'bbox',
            order: 'xy',
            boundsType: 'left-closed-right-open',
          },
        },
      },
    },
  },
  'gpt-6': {
    supportedProtocols: ['openai-chat', 'openai-responses'],
    resolveImageDetail: originalImageDetailForLocateIntent,
    imagePreprocess: gptImagePreprocess,
    responses: {
      replayRawAssistantOutput: false,
      unsupportedUserConfig: ['temperature', 'reasoningBudget'],
      buildResponsesParams: buildGpt6ResponsesParams,
    },
    buildCodexAppServerParams: buildGpt6CodexAppServerParams,
    chatCompletion: {
      unsupportedUserConfig: ['temperature', 'reasoningBudget'],
      buildChatCompletionParams: buildGpt6ChatCompletionParams,
    },
    locate: {
      element: {
        resultFormat: {
          // GPT can return image width/height as bbox endpoints (issue #3351).
          // Accept image-edge coordinates without assuming all variants do so.
          coordinates: {
            shape: 'bbox',
            order: 'xy',
            boundsType: 'left-closed-right-open',
          },
        },
      },
    },
  },
} satisfies Pick<
  Record<TModelFamily, ModelAdapterDefinition>,
  'gpt-5' | 'gpt-6'
>;
