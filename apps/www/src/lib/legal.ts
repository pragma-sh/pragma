/**
 * Facts the privacy policy states, kept in one place so the page and the App
 * Store Connect submission cannot drift apart. Apple checks the policy URL
 * against the app's declared data use.
 */

/** Date the privacy policy last changed, shown on the page. */
export const privacyLastUpdated = "August 24, 2026";

/**
 * Route serving the privacy policy. Submitted to App Store Connect verbatim,
 * so changing it means updating the listing too.
 *
 * Deliberately not in the site navigation: the policy is a submission artifact
 * reached by its URL, not a marketing page.
 */
export const privacyRoute = "/privacy";
