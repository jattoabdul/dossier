/** Synthetic-demo fetch policy. This is an application guard, not an OS network sandbox. */
export function demoFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "http://127.0.0.1:3999" || url.username || url.password) {
      throw new Error("Synthetic demo: external network requests are disabled.");
    }
    // Never follow a mock endpoint's redirect to an unapproved destination.
    return fetchImpl(input, { ...init, redirect: "error" });
  };
}
