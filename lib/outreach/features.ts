// Hard-coded product toggles for the outreach UI. Flip a value and redeploy the web app; no database or secret change needed.

/**
 * "Use the signed-in browser" sign-in method on the connect-sender wizard (hosted-auth browser extension / UniLogin).
 * OFF until the connector provider has confirmed the feature for our account. The backend (`outreach-sender-connect`)
 * keeps accepting `connect_method: "browser"`, so turning this on is the only step to re-enable it.
 * Docs: the matching paragraphs in outreach-app-docs are wrapped in MDX comments marked BROWSER_SIGNIN; un-comment them too.
 */
export const BROWSER_SIGNIN_ENABLED = false;
