import { prepareModelImage } from '@/ai-model/model-adapter/image-preprocess';
import { ResolvedModelAdapter } from '@/ai-model/model-adapter/resolve';
import { gptAdapters } from '@/ai-model/models/gpt';
import { localImg2Base64 } from '@midscene/shared/img';
import { describe, expect, it } from '@rstest/core';
import { getFixture } from '../../utils';

const gpt5Adapter = new ResolvedModelAdapter(gptAdapters['gpt-5'], 'gpt-5');
const gpt6Adapter = new ResolvedModelAdapter(gptAdapters['gpt-6'], 'gpt-6');

it.each(['gpt-5', 'gpt-6'] as const)(
  '%s uses current-turn reasoning with text-only history',
  (family) => {
    const adapter = new ResolvedModelAdapter(gptAdapters[family], family);
    expect(adapter.responses.replayRawAssistantOutput).toBe(false);
    expect(adapter.chatCompletion.replayRawAssistantMessage).toBe(false);
    expect(
      adapter.responses.buildResponsesParams({ userConfig: {} }).config
        .reasoning,
    ).toMatchObject({ context: 'current_turn' });
  },
);

describe.each(['gpt-5', 'gpt-6'] as const)(
  '%s Responses JSON mode',
  (family) => {
    const adapter = new ResolvedModelAdapter(gptAdapters[family], family);

    it.each([
      {
        responseFormat: undefined,
        expectedJsonObjectResponse: true,
        enabled: true,
      },
      {
        responseFormat: 'auto',
        expectedJsonObjectResponse: true,
        enabled: true,
      },
      {
        responseFormat: 'none',
        expectedJsonObjectResponse: true,
        enabled: false,
      },
      {
        responseFormat: 'auto',
        expectedJsonObjectResponse: false,
        enabled: false,
      },
    ] as const)(
      'handles %j',
      ({ responseFormat, expectedJsonObjectResponse, enabled }) => {
        const { config } = adapter.responses.buildResponsesParams({
          userConfig: { responseFormat },
          expectedJsonObjectResponse,
        });
        expect(config.text).toEqual(
          enabled ? { format: { type: 'json_object' } } : undefined,
        );
        expect(config).not.toHaveProperty('response_format');
      },
    );
  },
);

describe('GPT Codex App Server parameters', () => {
  it.each([
    {},
    { reasoningEnabled: true },
    { reasoningEnabled: false },
    { reasoningEffort: 'max' },
    { reasoningEnabled: true, reasoningEffort: 'high' },
    { reasoningEnabled: false, reasoningEffort: 'max' },
  ] as const)(
    'shares reasoning policy across providers for %j',
    (userConfig) => {
      for (const adapter of [gpt5Adapter, gpt6Adapter]) {
        expect(
          adapter.buildCodexAppServerParams({ userConfig }).config,
        ).toEqual({
          effort: adapter.chatCompletion.buildChatCompletionParams({
            userConfig,
          }).config.reasoning_effort,
        });
      }
    },
  );
});

describe('GPT provider-default reasoning', () => {
  it.each([undefined, 'high', 'max'])(
    'omits reasoning controls even with effort %s',
    (reasoningEffort) => {
      for (const adapter of [gpt5Adapter, gpt6Adapter]) {
        const input = {
          userConfig: {
            reasoningEnabled: 'default' as const,
            reasoningEffort,
            reasoningBudget: 1024,
          },
        };
        const chatConfig =
          adapter.chatCompletion.buildChatCompletionParams(input).config;
        const codexConfig = adapter.buildCodexAppServerParams(input).config;
        expect(JSON.parse(JSON.stringify(chatConfig))).not.toHaveProperty(
          'reasoning_effort',
        );
        expect(JSON.parse(JSON.stringify(codexConfig))).not.toHaveProperty(
          'effort',
        );
        expect(chatConfig).not.toHaveProperty('reasoning_budget');
      }
    },
  );
});

describe('gpt-6 model adapter', () => {
  it.each([undefined, false])(
    'defaults reasoning to low when enabled=%s',
    (reasoningEnabled) => {
      expect(
        gpt6Adapter.chatCompletion.buildChatCompletionParams({
          userConfig: { reasoningEnabled },
        }).config,
      ).toEqual({ reasoning_effort: 'low' });
    },
  );

  it('defaults enabled reasoning to medium', () => {
    expect(
      gpt6Adapter.chatCompletion.buildChatCompletionParams({
        userConfig: { reasoningEnabled: true },
      }).config.reasoning_effort,
    ).toBe('medium');
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max'])(
    'supports explicit effort %s',
    (reasoningEffort) => {
      expect(
        gpt6Adapter.chatCompletion.buildChatCompletionParams({
          userConfig: { reasoningEnabled: true, reasoningEffort },
        }).config.reasoning_effort,
      ).toBe(reasoningEffort);
    },
  );

  it.each([undefined, false])(
    'ignores explicit effort when enabled=%s',
    (reasoningEnabled) => {
      expect(
        gpt6Adapter.chatCompletion.buildChatCompletionParams({
          userConfig: { reasoningEnabled, reasoningEffort: 'high' },
        }).config.reasoning_effort,
      ).toBe('low');
    },
  );

  it.each([0, 1])(
    'omits temperature and reasoning budget on retry %s',
    (semanticRetryAttempt) => {
      expect(
        gpt6Adapter.chatCompletion.buildChatCompletionParams({
          userConfig: { temperature: 0.7, reasoningBudget: 1024 },
          semanticRetryAttempt,
        }).config,
      ).toEqual({ reasoning_effort: 'low' });
      expect(
        gpt6Adapter.chatCompletion.buildChatCompletionParams({
          semanticRetryAttempt,
        }).config,
      ).toEqual({ reasoning_effort: 'low' });
    },
  );

  it('uses JSON mode only when requested and not disabled', () => {
    expect(
      gpt6Adapter.chatCompletion.buildChatCompletionParams({
        expectedJsonObjectResponse: true,
      }).config.response_format,
    ).toEqual({ type: 'json_object' });
    expect(
      gpt6Adapter.chatCompletion.buildChatCompletionParams({
        expectedJsonObjectResponse: true,
        userConfig: { responseFormat: 'none' },
      }).config.response_format,
    ).toBeUndefined();
  });
});

describe('gpt model adapter', () => {
  it('keeps GPT-5 image-detail policy in the adapter', () => {
    expect(
      gpt5Adapter.chatCompletion.buildChatCompletionParams({
        userConfig: { temperature: 0 },
      }).config.temperature,
    ).toBe(0);
    expect(
      gpt5Adapter.chatCompletion.buildChatCompletionParams({
        userConfig: { temperature: 0.7 },
      }).config.temperature,
    ).toBe(0.7);
    expect(gpt5Adapter.chatCompletion.unsupportedUserConfig).toEqual([
      'reasoningBudget',
    ]);
    expect(
      gpt5Adapter.resolveImageDetail({
        intent: 'locate',
      }),
    ).toBe('original');
    expect(
      gpt5Adapter.resolveImageDetail({
        intent: 'planning',
      }),
    ).toBe('original');
    expect(gpt5Adapter.resolveImageDetail({ intent: 'default' })).toBe(
      'original',
    );
    expect(gpt5Adapter.resolveImageDetail({ intent: 'insight' })).toBe(
      'original',
    );
    expect(
      gpt5Adapter.resolveImageDetail({
        intent: 'planning',
        requiresOriginalImageDetail: true,
      }),
    ).toBe('original');
    expect(gpt5Adapter.imagePreprocess).toEqual({ padBlockSize: 32 });
  });

  it('keeps GPT-6 high detail outside locate', () => {
    expect(gpt6Adapter.resolveImageDetail({ intent: 'locate' })).toBe(
      'original',
    );
    expect(gpt6Adapter.resolveImageDetail({ intent: 'planning' })).toBe('high');
    expect(gpt6Adapter.imagePreprocess).toEqual({ padBlockSize: 32 });
  });

  it.each([
    ['gpt-5', gpt5Adapter],
    ['gpt-6', gpt6Adapter],
  ] as const)(
    'pads %s screenshots to 32px blocks without shifting locate results',
    async (family, adapter) => {
      const prepared = await prepareModelImage({
        imageBase64: localImg2Base64(getFixture('baidu.png')),
        width: 3282,
        height: 1442,
        policy: adapter.imagePreprocess,
      });
      expect(prepared.preparedSize).toEqual({ width: 3296, height: 1472 });
      expect(prepared.contentSize).toEqual({ width: 3282, height: 1442 });
      // The padded image is still sent at full resolution for locate.
      expect(adapter.resolveImageDetail({ intent: 'locate' })).toBe('original');
      if (adapter.locate.kind !== 'standard') {
        throw new Error('GPT should use the standard locate adapter');
      }
      const codec = adapter.locate.element.resultCodec;
      // Padding is appended right/bottom, so pixel bboxes map one to one.
      // Both GPT adapters use half-open image-edge bounds.
      const side = 200;
      expect(codec.toPixelResult([100, 200, 300, 400], prepared)).toEqual({
        center: [200, 300],
        rect: { left: 100, top: 200, width: side, height: side },
      });
      // A box reaching into the padding is clipped to the real screenshot.
      expect(
        codec.toPixelResult([3200, 1400, 3295, 1471], prepared).rect,
      ).toEqual({ left: 3200, top: 1400, width: 82, height: 42 });
    },
  );

  it('defaults gpt-5 reasoning to disabled when reasoning config is unset', () => {
    const result = gpt5Adapter.chatCompletion.buildChatCompletionParams({
      userConfig: {},
    });
    expect(result.config).toEqual({
      temperature: 0,
      reasoning_effort: 'none',
    });
  });

  it('omits token limit from adapter-owned GPT-5 chat completion params', () => {
    const result = gpt5Adapter.chatCompletion.buildChatCompletionParams({
      userConfig: {
        maxTokens: 2048,
      } as any,
    });
    expect(result.config).toEqual({
      temperature: 0,
      reasoning_effort: 'none',
    });
  });

  it('preserves midscene defaults and applies explicit gpt-5 temperature override', () => {
    const result = gptAdapters[
      'gpt-5'
    ].chatCompletion?.buildChatCompletionParams({
      midsceneDefaults: {
        temperature: 0,
        seed: 123,
      } as any,
      userConfig: {
        temperature: 0.7,
        reasoningEnabled: true,
      },
    });

    expect(result?.config).toEqual({
      temperature: 0.7,
      seed: 123,
      reasoning_effort: 'medium',
    });
  });

  it('maps reasoningEnabled to reasoning_effort for gpt-5', () => {
    const result = gpt5Adapter.chatCompletion.buildChatCompletionParams({
      userConfig: {
        reasoningEnabled: true,
      },
    });
    expect(result.config).toEqual({
      temperature: 0,
      reasoning_effort: 'medium',
    });
  });

  it('maps reasoningEnabled=false to reasoning_effort=none for gpt-5', () => {
    const result = gpt5Adapter.chatCompletion.buildChatCompletionParams({
      userConfig: {
        reasoningEnabled: false,
        reasoningEffort: 'low',
      },
    });
    expect(result.config).toEqual({
      temperature: 0,
      reasoning_effort: 'none',
    });
  });

  it('maps explicit reasoningEffort when gpt-5 reasoning is enabled', () => {
    const result = gpt5Adapter.chatCompletion.buildChatCompletionParams({
      userConfig: {
        reasoningEnabled: true,
        reasoningEffort: 'high',
      },
    });
    expect(result.config).toEqual({
      temperature: 0,
      reasoning_effort: 'high',
    });
  });

  it('ignores unsupported reasoning budget for gpt-5', () => {
    const result = gpt5Adapter.chatCompletion.buildChatCompletionParams({
      userConfig: {
        reasoningBudget: 1024,
      },
    });
    expect(result.config).toEqual({
      temperature: 0,
      reasoning_effort: 'none',
    });
  });

  it('uses json_object response format when expected for gpt-5', () => {
    const result = gpt5Adapter.chatCompletion.buildChatCompletionParams({
      expectedJsonObjectResponse: true,
      userConfig: {},
    });

    expect(result.config.response_format).toEqual({ type: 'json_object' });
  });

  it('does not use json_object response format when disabled', () => {
    const result = gpt5Adapter.chatCompletion.buildChatCompletionParams({
      expectedJsonObjectResponse: true,
      userConfig: { responseFormat: 'none' },
    });

    expect(result.config.response_format).toBeUndefined();
  });
});

it.each(['low', 'auto', 'high'] as const)(
  'preserves per-image %s detail unless GPT requires original',
  (imageDetail) => {
    expect(
      gpt5Adapter.resolveImageDetail({ intent: 'planning', imageDetail }),
    ).toBe(imageDetail);
    expect(
      gpt5Adapter.resolveImageDetail({ intent: 'locate', imageDetail }),
    ).toBe('original');
  },
);

describe.each(['gpt-5', 'gpt-6'] as const)('%s bbox boundaries', (family) => {
  const adapter = new ResolvedModelAdapter(gptAdapters[family], family);

  it('accepts image-edge endpoints for element and search-area results', () => {
    if (adapter.locate.kind !== 'standard' || !adapter.locate.searchArea) {
      throw new Error('Expected standard element and search-area locate');
    }
    for (const { resultCodec } of [
      adapter.locate.element,
      adapter.locate.searchArea,
    ]) {
      expect(
        resultCodec.toPixelResult([1600, 1600, 2000, 2000], {
          preparedSize: { width: 2000, height: 2000 },
        }),
      ).toEqual({
        center: [1800, 1800],
        rect: { left: 1600, top: 1600, width: 400, height: 400 },
      });
      // Variants returning the last pixel index remain accepted.
      expect(
        resultCodec.toPixelResult([1600, 1600, 1999, 1999], {
          preparedSize: { width: 2000, height: 2000 },
        }),
      ).toEqual({
        center: [1800, 1800],
        rect: { left: 1600, top: 1600, width: 399, height: 399 },
      });
      expect(
        resultCodec.toPixelResult([430, 240, 850, 720], {
          preparedSize: { width: 1280, height: 720 },
        }),
      ).toEqual({
        center: [640, 480],
        rect: { left: 430, top: 240, width: 420, height: 480 },
      });
      expect(() =>
        resultCodec.toPixelResult([1600, 1600, 2001, 2000], {
          preparedSize: { width: 2000, height: 2000 },
        }),
      ).toThrow(/exceed/);
    }
  });
});
