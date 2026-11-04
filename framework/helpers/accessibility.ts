import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/** WCAG 2.0 and 2.1 A and AA rules, plus axe's best-practice rules such as heading order and landmarks. */
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

export interface AxeSummary {
  label: string;
  violations: { id: string; impact: string; help: string; targets: string[] }[];
  /** Rules axe could not decide, such as contrast over an image. These need a person to look. */
  incomplete: { id: string; targets: string[] }[];
  rulesPassed: number;
  contrastChecked: boolean;
}

function describe(nodes: { target: unknown[] }[]): string[] {
  return nodes.map((node) => node.target.map(String).join(" "));
}

export async function scan(page: Page, label: string): Promise<AxeSummary> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const ran = [...results.violations, ...results.passes, ...results.incomplete];
  const summary: AxeSummary = {
    label,
    violations: results.violations.map((rule) => ({
      id: rule.id,
      impact: rule.impact ?? "unknown",
      help: rule.help,
      targets: describe(rule.nodes),
    })),
    incomplete: results.incomplete.map((rule) => ({ id: rule.id, targets: describe(rule.nodes) })),
    rulesPassed: results.passes.length,
    contrastChecked: ran.some((rule) => rule.id === "color-contrast"),
  };
  await test.info().attach(`axe-${label}`, { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
  return summary;
}

/** No rule is disabled. A pass only means axe found nothing: it cannot show WCAG conformance. */
export async function expectNoAxeViolations(page: Page, label: string): Promise<void> {
  const summary = await scan(page, label);
  expect(summary.violations, `axe violations on ${label}`).toEqual([]);
  expect(summary.contrastChecked, `color contrast was evaluated on ${label}`).toBe(true);
}

/** One h1, and no level skipped on the way down. */
export async function expectHeadingHierarchy(page: Page): Promise<void> {
  const levels = await page
    .locator("h1, h2, h3, h4, h5, h6")
    .evaluateAll((items) => items.filter((item) => item.checkVisibility()).map((item) => Number(item.tagName[1])));
  expect(levels.filter((level) => level === 1), `one h1 in ${levels.join(",")}`).toHaveLength(1);
  const skips = levels.filter((level, index) => index > 0 && level > (levels[index - 1] ?? 0) + 1);
  expect(skips, `heading levels ${levels.join(",")}`).toEqual([]);
}

/** Every visible control has a real label association, or an explicit name where a label cannot fit. */
export async function expectControlsLabelled(page: Page): Promise<void> {
  const unlabelled = await page.locator("input, select, textarea").evaluateAll((items) =>
    items
      .filter((item) => item.checkVisibility())
      .filter((item) => {
        const control = item as HTMLInputElement;
        const label = control.labels?.[0]?.textContent?.trim();
        return !label && !control.getAttribute("aria-label");
      })
      .map((item) => item.outerHTML.slice(0, 120)),
  );
  expect(unlabelled, "controls with no label").toEqual([]);
}

export async function expectAccessiblePage(page: Page, label: string): Promise<void> {
  await expectNoAxeViolations(page, label);
  await expectHeadingHierarchy(page);
  await expectControlsLabelled(page);
}

export interface FocusStop {
  description: string;
  visibleIndicator: boolean;
  inViewport: boolean;
}

/** What is focused now, and whether a sighted keyboard user could see that. */
export function focusStop(page: Page): Promise<FocusStop | null> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return null;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const outlined = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 1;
    return {
      description: `${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 60)}"`,
      visibleIndicator: outlined || style.boxShadow !== "none",
      inViewport: box.width > 0 && box.height > 0 && box.left >= 0 && box.top >= 0 && box.left < innerWidth && box.top < innerHeight,
    };
  });
}

/** Tab through the page until focus leaves it, checking each stop has a visible focus indicator. */
export async function tabThroughPage(page: Page, maxStops: number): Promise<FocusStop[]> {
  const stops: FocusStop[] = [];
  for (let index = 0; index < maxStops; index++) {
    await page.keyboard.press("Tab");
    const stop = await focusStop(page);
    if (!stop) break;
    stops.push(stop);
  }
  return stops;
}

/** Fails if focus has fallen back to the page body, where a keyboard user loses their place. */
export async function expectFocusNotLost(page: Page, context: string): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName), context).not.toBe("BODY");
}
