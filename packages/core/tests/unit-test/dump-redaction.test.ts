import {
  generateAgentReportComment,
  generateTestRunReportScriptTag,
} from '@/dump/html-utils';
import {
  clearDumpTextRedactors,
  hasDumpTextRedactor,
  redactDumpText,
  registerDumpSecret,
  registerDumpTextRedactor,
} from '@/dump/redaction';
import { ExecutionDump, ReportActionDump } from '@/dump/report-action-dump';
import { executionToMarkdown, reportToMarkdown } from '@/report-markdown';
import { ScreenshotItem } from '@/screenshot-item';
import type { TestRunReportDump } from '@/test-run-report';
import { afterEach, describe, expect, it } from '@rstest/core';

// A quote and a backslash make the JSON-escaped forms differ from the raw one.
const secret = 'sup3r"secret\\passw0rd';
const escapedOnce = JSON.stringify(secret).slice(1, -1);
const escapedTwice = JSON.stringify(escapedOnce).slice(1, -1);
const onePixelPng =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const buildExecution = () =>
  new ExecutionDump({
    name: `Act - login with ${secret}`,
    logTime: 0,
    aiActContext: `password is ${secret}`,
    tasks: [
      {
        type: 'Planning',
        subType: 'Plan',
        status: 'finished',
        param: { userInstruction: `login with ${secret}` },
        output: {
          log: `typed ${secret} into the password field`,
          // The raw model response is itself JSON text.
          rawResponse: JSON.stringify({
            action: { type: 'Input', param: { value: secret } },
          }),
          // A model message that embeds that JSON once more.
          rawAssistantOutput: {
            type: 'chat-completion',
            rawValue: {
              role: 'assistant',
              content: JSON.stringify({
                reply: JSON.stringify({ value: secret }),
              }),
            },
          },
        },
        recorder: [
          {
            type: 'screenshot',
            ts: 1,
            screenshot: ScreenshotItem.create(onePixelPng, 1),
            description: `after typing ${secret}`,
          },
        ],
      } as any,
      {
        type: 'Action Space',
        subType: 'Input',
        status: 'finished',
        param: { value: secret, mode: 'replace' },
      } as any,
    ],
  });

const buildReport = () =>
  new ReportActionDump({
    sdkVersion: '0.0.0',
    groupName: `Login ${secret}`,
    groupDescription: undefined,
    modelBriefs: [],
    executions: [buildExecution()],
  });

const expectRedacted = (text: string) => {
  expect(text).not.toContain(secret);
  expect(text).not.toContain(escapedOnce);
  expect(text).not.toContain(escapedTwice);
  expect(text).toContain('[REDACTED]');
};

afterEach(() => {
  clearDumpTextRedactors();
});

describe('dump text redaction', () => {
  it('passes text through untouched when nothing is registered', () => {
    expect(hasDumpTextRedactor()).toBe(false);
    expect(redactDumpText(`login with ${secret}`)).toBe(`login with ${secret}`);
    expect(buildReport().serialize()).toContain(escapedOnce);
  });

  it('masks every occurrence of a registered secret, raw and JSON-escaped', () => {
    registerDumpSecret(secret);

    expect(redactDumpText(`a ${secret} b ${secret}`)).toBe(
      'a [REDACTED] b [REDACTED]',
    );
    expect(redactDumpText(JSON.stringify({ value: secret }))).toBe(
      '{"value":"[REDACTED]"}',
    );
    expect(
      redactDumpText(JSON.stringify(JSON.stringify({ value: secret }))),
    ).toBe(JSON.stringify(JSON.stringify({ value: '[REDACTED]' })));
  });

  it('masks tasks, logs, screenshot metadata and model messages in the dump', () => {
    registerDumpSecret(secret);

    const serialized = buildReport().serialize();
    expectRedacted(serialized);

    const parsed = JSON.parse(serialized);
    const [planning, input] = parsed.executions[0].tasks;
    expect(parsed.groupName).toBe('Login [REDACTED]');
    expect(parsed.executions[0].name).toBe('Act - login with [REDACTED]');
    expect(parsed.executions[0].aiActContext).toBe('password is [REDACTED]');
    expect(planning.param.userInstruction).toBe('login with [REDACTED]');
    expect(planning.output.log).toBe(
      'typed [REDACTED] into the password field',
    );
    expect(JSON.parse(planning.output.rawResponse)).toEqual({
      action: { type: 'Input', param: { value: '[REDACTED]' } },
    });
    expect(
      JSON.parse(
        JSON.parse(planning.output.rawAssistantOutput.rawValue.content).reply,
      ),
    ).toEqual({ value: '[REDACTED]' });
    expect(planning.recorder[0].description).toBe('after typing [REDACTED]');
    expect(planning.recorder[0].screenshot.type).toBe(
      'midscene_screenshot_ref',
    );
    expect(input.param.value).toBe('[REDACTED]');
  });

  it('masks a single execution dump', () => {
    registerDumpSecret(secret, { mask: '***' });
    const serialized = buildExecution().serialize();
    expect(serialized).not.toContain(escapedOnce);
    expect(JSON.parse(serialized).tasks[1].param.value).toBe('***');
  });

  it('masks the inline-screenshot serialization without touching image data', () => {
    registerDumpSecret(secret);
    // A value that also occurs inside the screenshot's base64 body.
    registerDumpSecret('iVBORw0KGgo');

    const serialized = buildReport().serializeWithInlineScreenshots();
    expectRedacted(serialized);
    const parsed = JSON.parse(serialized);
    expect(parsed.executions[0].tasks[0].recorder[0].screenshot.base64).toBe(
      onePixelPng,
    );
  });

  it('masks the reference-image serialization used by HTML reports', () => {
    registerDumpSecret(secret);
    expectRedacted(buildReport().serializeWithReferenceImages(new Map()));
  });

  it('masks the test-run dump and the agent comment written into reports', () => {
    registerDumpSecret(secret);

    const runnerDump = {
      schemaVersion: 1,
      kind: 'test-runner',
      runId: 'run-1',
      projects: [{ name: `login ${secret}` }],
    } as unknown as TestRunReportDump;
    expectRedacted(generateTestRunReportScriptTag(runnerDump));

    const comment = generateAgentReportComment(buildReport().toJSON());
    expect(comment).not.toContain(secret);
    expect(comment).toContain('Report: Login [REDACTED]');
  });

  it('masks Markdown exports', () => {
    registerDumpSecret(secret);

    const execution = executionToMarkdown(buildExecution()).markdown;
    expect(execution).not.toContain(secret);
    expect(execution).not.toContain(escapedOnce);
    expect(reportToMarkdown(buildReport()).markdown).not.toContain(secret);
  });

  it('applies custom redactors and keeps the others when one throws', () => {
    registerDumpTextRedactor(() => {
      throw new Error('bad redactor');
    });
    registerDumpTextRedactor((text) => text.replace(/passw0rd/g, '<pw>'));

    const serialized = buildReport().serialize();
    expect(serialized).not.toContain('passw0rd');
    expect(serialized).toContain('<pw>');
  });

  it('stops redacting once the registration is disposed', () => {
    const dispose = registerDumpSecret(secret);
    expect(buildReport().serialize()).not.toContain(escapedOnce);

    dispose();
    expect(hasDumpTextRedactor()).toBe(false);
    expect(buildReport().serialize()).toContain(escapedOnce);
  });

  it('rejects an empty secret', () => {
    expect(() => registerDumpSecret('')).toThrow(/non-empty string/);
    expect(hasDumpTextRedactor()).toBe(false);
  });
});
