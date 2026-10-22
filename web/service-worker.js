// Only a same-origin path is ever opened: "/..." but not "//host" or "/\host",
// which browsers resolve to another origin.
function sameOriginPath(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.startsWith("/\\")) return "/";
  try {
    const resolved = new URL(value, self.location.origin);
    if (resolved.origin !== self.location.origin) return "/";
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return "/";
  }
}

// The session a push deep link names (`/?session=<id>`), or null.
function sessionFromPath(path) {
  try {
    const id = new URL(path, self.location.origin).searchParams.get("session");
    return id && /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json?.() || {};
  } catch {
    payload = {};
  }
  const title =
    typeof payload.title === "string" && payload.title
      ? payload.title
      : "DeckTerm";
  const options = {
    body:
      typeof payload.body === "string" && payload.body
        ? payload.body
        : "Work finished",
    tag:
      typeof payload.tag === "string" && payload.tag
        ? payload.tag
        : "deckterm-completion",
    data: {
      url: sameOriginPath(payload.data?.url),
    },
    icon: "/app-icon.svg",
    badge: "/app-icon.svg",
    silent: payload.silent === true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// On click: focus an open DeckTerm window and, for a session deep link, post
// {type:"deckterm-open-session", terminalId} to it (no reload). With no window
// open, open the deep link.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = sameOriginPath(event.notification.data?.url || "/");
  const targetUrl = new URL(path, self.location.origin).href;
  const terminalId = sessionFromPath(path);
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clients) => {
        for (const client of clients) {
          if (new URL(client.url).origin !== self.location.origin) continue;
          await client.focus();
          if (terminalId) {
            client.postMessage({ type: "deckterm-open-session", terminalId });
          } else if ("navigate" in client && client.url !== targetUrl) {
            await client.navigate(targetUrl);
          }
          return;
        }
        await self.clients.openWindow(targetUrl);
      }),
  );
});
