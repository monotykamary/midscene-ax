import { type AgentOpt, Agent as PageAgent } from '@midscene/core/agent';
import { BROWSER_NAVIGATION_ERROR_PATTERN } from '../puppeteer/base-page';
import { type BrowserHarnessConnectOptions, BrowserHarnessPage } from './page';

/**
 * A Midscene agent on a browser-harness-js page: locates through the
 * accessibility tree first and falls back to vision when the tree cannot
 * name exactly one perceivable element.
 */
export class BrowserHarnessAgent extends PageAgent<BrowserHarnessPage> {
  /** Connect to Chrome, attach to (or open) a tab and wrap it in an agent. */
  static async connect(
    options: BrowserHarnessConnectOptions,
    agentOpt?: AgentOpt,
  ): Promise<BrowserHarnessAgent> {
    const page = await BrowserHarnessPage.connect(options);
    return new BrowserHarnessAgent(page, agentOpt);
  }

  protected isRetryableContextError(error: unknown): boolean {
    return (
      error instanceof Error &&
      BROWSER_NAVIGATION_ERROR_PATTERN.test(error.message)
    );
  }
}
