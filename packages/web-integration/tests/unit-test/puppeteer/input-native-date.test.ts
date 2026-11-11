import { PuppeteerWebPage } from '@/puppeteer/page';
import { afterAll, beforeAll, describe, expect, test } from '@rstest/core';
import puppeteer, { type Browser } from 'puppeteer';

/**
 * Native date and time inputs draw a segmented editor: an ISO value typed
 * into an en-US `<input type=date>` came out as "10/11/0002". The Input
 * action sets these fields directly instead of typing.
 */

const PUPPETEER_TEST_TIMEOUT_MS = 120000;

let browser: Browser;

beforeAll(async () => {
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=en-US'],
  });
}, PUPPETEER_TEST_TIMEOUT_MS);

afterAll(async () => {
  await browser?.close();
}, PUPPETEER_TEST_TIMEOUT_MS);

const PAGE_HTML = `
  <!DOCTYPE html>
  <html>
    <body style="padding: 24px;">
      <input id="d" type="date" style="width: 240px; height: 32px;" />
      <input id="t" type="time" style="width: 240px; height: 32px;" />
      <input id="x" type="text" style="width: 240px; height: 32px;" />
      <div id="log"></div>
      <script>
        for (const id of ['d', 't']) {
          document.getElementById(id).addEventListener('change', (e) => {
            document.getElementById('log').textContent += id + '=' + e.target.value + ';';
          });
        }
      </script>
    </body>
  </html>
`;

const centerOf = async (page: any, selector: string) =>
  page.$eval(selector, (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2] as [number, number];
  });

const input = async (
  webPage: PuppeteerWebPage,
  value: string,
  center: [number, number],
) => {
  const inputAction = webPage.actionSpace().find((a) => a.name === 'Input');
  await inputAction!.call({ value, locate: { center } } as any, {} as any);
};

describe('Input action on native date and time inputs', () => {
  test(
    'sets the value the input expects and fires change',
    async () => {
      const page = await browser.newPage();
      await page.setContent(PAGE_HTML);
      const webPage = new PuppeteerWebPage(page, {});

      await input(webPage, '2026-11-10', await centerOf(page, '#d'));
      expect(await page.$eval('#d', (el: any) => el.value)).toBe('2026-11-10');

      await input(webPage, 'Nov 12, 2026', await centerOf(page, '#d'));
      expect(await page.$eval('#d', (el: any) => el.value)).toBe('2026-11-12');

      await input(webPage, '2:30 PM', await centerOf(page, '#t'));
      expect(await page.$eval('#t', (el: any) => el.value)).toBe('14:30');

      expect(await page.$eval('#log', (el: any) => el.textContent)).toBe(
        'd=2026-11-10;d=2026-11-12;t=14:30;',
      );

      // A plain text field is still typed into.
      await input(webPage, '2026-11-10', await centerOf(page, '#x'));
      expect(await page.$eval('#x', (el: any) => el.value)).toBe('2026-11-10');

      await page.close();
    },
    PUPPETEER_TEST_TIMEOUT_MS,
  );

  test(
    'reads digits typed without separators in the order the field shows',
    async () => {
      const page = await browser.newPage();
      await page.setContent(PAGE_HTML);
      const webPage = new PuppeteerWebPage(page, {});
      const d = await centerOf(page, '#d');
      const value = () => page.$eval('#d', (el: any) => el.value);

      // The browser draws the fields in the system region's order (dd/mm on a
      // Vietnamese-region Mac even under --lang=en-US); digits fill them in
      // that order.
      const dayFirst = await webPage.dateFieldsDayFirst();
      expect(typeof dayFirst).toBe('boolean');
      await input(webPage, '11102026', d);
      expect(await value()).toBe(dayFirst ? '2026-10-11' : '2026-11-10');
      await input(webPage, '20261205', d);
      expect(await value()).toBe('2026-12-05');
      // A first number above 12 can only be a day.
      await input(webPage, '25/11/2026', d);
      expect(await value()).toBe('2026-11-25');

      // The step named the date: digits in either order mean that date
      // (superapp flights-009).
      webPage.dateHints = ['2026-11-10'];
      await input(webPage, '11102026', d);
      expect(await value()).toBe('2026-11-10');
      await input(webPage, '10112026', d);
      expect(await value()).toBe('2026-11-10');
      webPage.dateHints = [];

      await page.close();
    },
    PUPPETEER_TEST_TIMEOUT_MS,
  );

  test(
    'types a date in the format a text field names (superapp meridian-008)',
    async () => {
      const page = await browser.newPage();
      await page.setContent(`
        <!DOCTYPE html>
        <html><body style="padding: 24px;">
          <input id="us" type="text" placeholder="mm/dd/yyyy" style="width: 240px; height: 32px;" />
          <input id="eu" type="text" data-datepicker="dd/mm/yyyy" style="width: 240px; height: 32px;" />
          <input id="free" type="text" style="width: 240px; height: 32px;" />
        </body></html>
      `);
      const webPage = new PuppeteerWebPage(page, {});
      const value = (sel: string) => page.$eval(sel, (el: any) => el.value);

      const us = await centerOf(page, '#us');
      await input(webPage, '12242026', us);
      expect(await value('#us')).toBe('12/24/2026');
      await input(webPage, '2026-12-24', us);
      expect(await value('#us')).toBe('12/24/2026');
      await input(webPage, 'Dec 24, 2026', us);
      expect(await value('#us')).toBe('12/24/2026');
      await input(webPage, '12/24/2026', us);
      expect(await value('#us')).toBe('12/24/2026');

      const eu = await centerOf(page, '#eu');
      await input(webPage, '24122026', eu);
      expect(await value('#eu')).toBe('24/12/2026');
      await input(webPage, '2026-12-24', eu);
      expect(await value('#eu')).toBe('24/12/2026');

      // A field that names no format is typed as is.
      await input(webPage, '12242026', await centerOf(page, '#free'));
      expect(await value('#free')).toBe('12242026');

      await page.close();
    },
    PUPPETEER_TEST_TIMEOUT_MS,
  );

  test(
    'types into a field whose center a popup covers (superapp meridian-008)',
    async () => {
      const page = await browser.newPage();
      await page.setContent(`
        <!DOCTYPE html>
        <html><body style="padding: 24px;">
          <input id="date" type="text" style="display: block; width: 400px; height: 32px;" />
          <textarea id="comment" style="display: block; margin-top: 8px; width: 400px; height: 120px;"></textarea>
          <div id="popup" style="position: absolute; left: 24px; top: 64px; width: 240px; height: 200px; background: #fff; border: 1px solid #999;"></div>
        </body></html>
      `);
      const webPage = new PuppeteerWebPage(page, {});
      await page.$eval('#date', (el: any) => {
        el.value = '12/24/2026';
        el.focus();
      });

      await input(webPage, 'Follow-up visit', await centerOf(page, '#comment'));
      expect(await page.$eval('#comment', (el: any) => el.value)).toBe(
        'Follow-up visit',
      );
      expect(await page.$eval('#date', (el: any) => el.value)).toBe(
        '12/24/2026',
      );

      await page.close();
    },
    PUPPETEER_TEST_TIMEOUT_MS,
  );
});
