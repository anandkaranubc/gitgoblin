/**
 * Turns the errors a first-time user is most likely to meet into a sentence they can act on. Both
 * are recognised by shape rather than class, because they come from Node's fetch and from sibling
 * packages whose error classes the CLI does not import.
 */

type Cause = { code?: unknown; hostname?: unknown; message?: unknown; errors?: unknown };

const TLS_CODES = /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|DEPTH_ZERO/;

/** Node's fetch rejects with `TypeError: fetch failed` and hides the reason in `cause`. */
export function explainNetworkFailure(error: unknown): string | undefined {
  if (!(error instanceof TypeError) || error.message !== "fetch failed") return undefined;
  const cause = (error as { cause?: Cause }).cause;
  // A failed connection to several addresses arrives as an AggregateError; its first error has the host.
  const first = Array.isArray(cause?.errors) ? (cause.errors[0] as Cause | undefined) : undefined;
  const code = [cause?.code, first?.code].find((c): c is string => typeof c === "string");
  const host = [cause?.hostname, first?.hostname].find((h): h is string => typeof h === "string");
  if (code && TLS_CODES.test(code)) {
    return `a TLS certificate could not be verified (${code}). A proxy that inspects HTTPS usually causes this; point NODE_EXTRA_CA_CERTS at its certificate.`;
  }
  return `could not reach ${host ?? "the network"} (${code ?? "fetch failed"}). Check your internet connection or proxy settings.`;
}

/** A 404 for exactly `/repos/<owner>/<name>` means the repository asked for does not exist or is hidden. */
export function explainMissingRepository(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const { status, message } = error as { status?: unknown; message?: unknown };
  if (status !== 404 || typeof message !== "string") return undefined;
  const match = /https:\/\/api\.github\.com\/repos\/([^/\s]+)\/([^/\s?#]+)(?:[?#]\S*)?$/.exec(message);
  if (!match) return undefined;
  return `${match[1]}/${match[2]} was not found on github.com (or it is private and your token cannot see it).`;
}
