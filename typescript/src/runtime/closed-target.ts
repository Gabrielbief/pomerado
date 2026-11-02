/**
 * Playwright's message for a call whose target closed under it: a page, context or browser, or a
 * cross-site frame, which runs as a target of its own. Page code embeds it as a literal.
 */
export const closedTargetMessage = /has been closed|Target closed|Browser closed/u;
