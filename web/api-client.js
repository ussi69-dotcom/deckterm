// A custom header makes unsafe same-origin requests distinguishable from
// cross-site form submissions. Authentication remains enforced by the server.
(function () {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = new URL(
      input instanceof Request ? input.url : input,
      location.href,
    );
    const method = String(
      init?.method || (input instanceof Request ? input.method : "GET"),
    ).toUpperCase();
    if (
      url.origin !== location.origin ||
      !url.pathname.startsWith("/api/") ||
      ["GET", "HEAD", "OPTIONS"].includes(method)
    ) {
      return nativeFetch(input, init);
    }
    const headers = new Headers(
      init?.headers || (input instanceof Request ? input.headers : undefined),
    );
    headers.set("X-DeckTerm-Request", "1");
    return nativeFetch(input, { ...init, headers });
  };
})();
