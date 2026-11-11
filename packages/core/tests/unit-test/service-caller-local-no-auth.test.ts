import type { IModelConfig } from '@midscene/shared/env';
import { afterEach, beforeEach, describe, expect, it, rs } from '@rstest/core';
import OpenAI from 'openai' with { rstest: 'importActual' };

const mockCreate = rs.fn();

rs.mock('openai', () => {
  return {
    default: rs.fn().mockImplementation((options) => {
      const client = new OpenAI(options);
      client.chat.completions.create = mockCreate;
      return client;
    }),
  };
});

const baseConfig = (overrides: Partial<IModelConfig> = {}): IModelConfig =>
  ({
    modelName: 'local-model',
    openaiApiKey: undefined,
    modelDescription: 'test model',
    intent: 'default',
    slot: 'default',
    retryCount: 0,
    ...overrides,
  }) as IModelConfig;

const lastOpenAIOptions = async () => {
  const MockedOpenAI = (await import('openai'))
    .default as unknown as ReturnType<typeof rs.fn>;
  return MockedOpenAI.mock.calls.at(-1)?.[0];
};

describe('local OpenAI-compatible endpoints without an API key', () => {
  beforeEach(() => {
    rs.clearAllMocks();
    // The SDK falls back to this variable when no key is passed.
    rs.stubEnv('OPENAI_API_KEY', undefined);
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'ok' } }],
    });
  });

  afterEach(() => {
    rs.unstubAllEnvs();
  });

  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:1234/v1',
    'http://[::1]:8080/v1',
  ])('calls %s with an empty API key', async (openaiBaseURL) => {
    const { callGenerativeAI } = await import('@/ai-model/service-caller');
    const { getModelRuntime } = await import('@/ai-model/models');

    const result = await callGenerativeAI(
      [{ role: 'user', content: 'hello' }],
      getModelRuntime(baseConfig({ openaiBaseURL })),
    );

    expect(result.content).toBe('ok');
    expect((await lastOpenAIOptions())?.apiKey).toBe('');
  });

  it('keeps a configured key for a local endpoint', async () => {
    const { callGenerativeAI } = await import('@/ai-model/service-caller');
    const { getModelRuntime } = await import('@/ai-model/models');

    await callGenerativeAI(
      [{ role: 'user', content: 'hello' }],
      getModelRuntime(
        baseConfig({
          openaiBaseURL: 'http://localhost:11434/v1',
          openaiApiKey: 'local-key',
        }),
      ),
    );

    expect((await lastOpenAIOptions())?.apiKey).toBe('local-key');
  });

  it.each([
    'https://api.openai.com/v1',
    'https://localhost:11434/v1',
    'http://192.168.1.10:11434/v1',
  ])('still requires an API key for %s', async (openaiBaseURL) => {
    const { callGenerativeAI } = await import('@/ai-model/service-caller');
    const { getModelRuntime } = await import('@/ai-model/models');

    await expect(
      callGenerativeAI(
        [{ role: 'user', content: 'hello' }],
        getModelRuntime(baseConfig({ openaiBaseURL })),
      ),
    ).rejects.toThrow(/OPENAI_API_KEY/);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
