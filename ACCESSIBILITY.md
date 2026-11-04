# Accessibility Testing

What was tested and what was found. **Automated checks cannot show WCAG conformance, and this document
does not claim it.** axe-core finds a subset of accessibility problems, and no assistive technology has
been used with this app.

## Commands

```bash
npm run test:a11y            # axe, semantics, focus visibility and keyboard tests, in Chromium
npm run test:a11y:keyboard   # keyboard tests in WebKit
```

Each scan's full result is attached to the HTML report as `axe-<screen>`.

## Results

| Suite | Browser | Passed | Failed | Skipped | Flaky |
| --- | --- | --- | --- | --- | --- |
| axe scans (`axe.spec.ts`) | Chromium 156 | 30 | 0 | 0 | 0 |
| Semantics and focus visibility (`semantics.spec.ts`) | Chromium 156 | 19 | 0 | 0 | 0 |
| Keyboard (`keyboard.spec.ts`) | Chromium 156 | 33 | 0 | 0 | 0 |
| Keyboard (`keyboard.spec.ts`) | WebKit 27.2 | 33 | 0 | 0 | 0 |
| Keyboard (`keyboard.spec.ts`) | Firefox 157 | **0: unverified** | 33 at launch, no test body ran | 0 | 0 |

Retries were off. In Phase 4, before the support page was added, the Chromium and WebKit suites run 3 times over gave 336 passed and 0 failed. That repeat was not run again in Phase 5.

## axe-core

axe-core 4.14 ran with the `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and `best-practice` tags. **No rule is
disabled or excluded.** The final run scanned 41 screen states with **0 violations**. Four of them, on the support page, were added in Phase 5.

| Area | States scanned |
| --- | --- |
| Sign in | Form, validation errors, authentication error, session ended |
| Dashboard | Staff, customer-scoped buyer, 320px wide |
| Orders | Grid with every status, no results, 320px wide |
| Order details | Payment form, declined payment, delivered, buyer view, not found |
| Order creation | Empty, validation errors, stock error from the server, 320px wide |
| Dialogs | Status, status with server error, new product, its errors, edit, retire, adjust, its errors, new user |
| Products and inventory | Grids, product details, success toast, inventory at 320px wide |
| Other | Users, audit log, access denied, page not found |
| Support | Form, validation error, answer, refusal |

### Needs manual review

axe could not decide these, and they are **not** counted as passes. Nobody has reviewed them yet.

| Rule | Where | Likely explanation, not confirmed |
| --- | --- | --- |
| `color-contrast` | Sort arrows on grids | Decorative, `aria-hidden`, partly transparent |
| `color-contrast` | Table cells at 320px wide, retire dialog, inventory with a toast | Clipped or overlapping content |
| `label-content-name-mismatch` | Dialog close and toast dismiss buttons | The visible text is `×`, the name is "Close" or "Dismiss" |

## Beyond axe

| Check | How it is tested |
| --- | --- |
| Accessible names | axe, plus dialog names and the close button by role |
| Label associations | Every visible control has a label or explicit name. Clicking a label focuses its control |
| Heading hierarchy | One `h1` and no skipped level on every scanned state |
| Form errors | `aria-invalid` and accessible description on the right field, including on the right order line. They clear when corrected |
| Server errors | Announced with `role="alert"` |
| Dialogs | `dialog` role, a name, focus inside, and the `:modal` state, which makes the page behind inert |
| Focus visibility | Tabs through each page, checking every stop has a computed outline |
| Reflow | No page-level horizontal scrolling at 320px wide on 4 pages |
| Non-color cues | Status badges carry text |

## Keyboard coverage

| Area | Tested |
| --- | --- |
| Tab and Shift+Tab | Login, filters, sort headers, row actions and pagination |
| Skip link | Visible on focus, and moves focus to the content |
| Enter and Space | Buttons, sort headers, links, checkbox, form submission |
| Escape | Closes a dialog and returns focus to its opener |
| Focus trap | Tab and Shift+Tab stay inside a dialog |
| Dropdowns and filters | Type-ahead selection, applied on Enter or on change, focus stays in place |
| After validation errors | Focus moves to the first invalid field, on 4 forms |
| After actions | Focus survives a server error, a payment, a removed line, a retired product and the last page |

**WebKit uses Option+Tab.** Safari skips links and buttons with plain Tab unless the user changes a setting. A plain
Tab test would measure that browser default, not this app.

## Defects found and fixed

| # | Defect | Severity | Found by |
| --- | --- | --- | --- |
| 1 | Duplicate landmark names: a section and its table had the same name on the dashboard, order details and product details | Moderate (axe `landmark-unique`) | axe |
| 2 | No `h1` on access denied, page not found, order not found and product not found | Moderate (axe `page-has-heading-one`) | axe |
| 3 | A failed form left focus on the button, so keyboard and screen reader users had to find the error themselves. Affected login, new order, inventory, new and edit product, new user | Serious | Keyboard test |
| 4 | A rejected sign-in cleared the password but left focus elsewhere | Moderate | Keyboard test |
| 5 | Focus fell to the page body when an action removed its own control: status changes, successful payments, retiring a product | Serious | Keyboard test |
| 6 | Busy submit buttons used `disabled`, which dropped focus to the page body in Chromium and WebKit. Now `aria-disabled` with a guard against double submission | Serious | Keyboard test |
| 7 | Reaching the last page disabled the focused Next button, with the same result | Moderate | Keyboard test |
| 8 | Removing an order line lost focus. It now moves to Add line | Moderate | Keyboard test |
| 9 | Dialogs opened with focus on the close button. They now start on the first field | Minor | Keyboard test |
| 10 | Date fields showed no outline when focused, only the browser's small segment highlight | Moderate | Focus visibility test |

Severity is this project's own judgement.

**Remaining violations: none found by these tests.** That is not the same as none existing.

## Do the tests detect real problems?

Each of these was temporarily put back, and the suites were run. All 17 were caught, and every file was restored.

Focus indicator removed · low text contrast · labels not associated · error and hint not tied to the field ·
`aria-invalid` not set · dialog with no name · dialog not restoring focus · non-modal dialog · unnamed close button ·
skip link removed · no focus on first invalid field · skipped heading level · duplicate region names · pages with no
`h1` · busy buttons losing focus · focus lost when the opener disappears · sort buttons unreachable by Tab.

This exposed weak tests. Two of these bugs first went undetected, because the tests focused controls by script rather
than reaching them with Tab. New tests were added. It is a hand-picked list, not full mutation testing.

## Limitations

- **No screen reader was used.** VoiceOver, NVDA and JAWS behaviour is untested, including whether announcements are
  useful.
- **Firefox is unverified,** because it cannot launch on this machine. Its keyboard project should run in Linux CI in Phase 6.
- **WebKit is Playwright's build,** not Safari.
- **Focus indicators are checked for presence,** not for contrast or size against WCAG 2.2.
- **Reflow is checked on 4 pages at 320px.** Text spacing, 200% zoom and high-contrast modes are untested. Wide tables scroll inside
  their own region.
- **Hover states, target size, motion and cognitive load** are not assessed.
- **Native `<dialog>` and `<select>` behaviour** depends on the browser, and was only seen in these two engines.
- **Color contrast is only tested in the states scanned.**
