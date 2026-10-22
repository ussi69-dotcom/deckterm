// Only a same-origin URL is ever opened. Every helper returns an ABSOLUTE
// URL that was checked against the origin: a path that is re-resolved later
// can turn into another origin ("/x/..//evil.example/" normalizes to the
// protocol-relative "//evil.example/").
function originRoot() {
  return new URL("/", self.location.origin).href;
}

function sameOriginUrl(value) {
  if (typeof value !== "string" || value === "") return originRoot();
  if (value.startsWith("//") || value.startsWith("/\\")) return originRoot();
  try {
    const resolved = new URL(value, self.location.origin);
    return resolved.origin === self.location.origin
      ? resolved.href
      : originRoot();
  } catch {
    return originRoot();
  }
}

// The last check, right before a URL is opened or navigated to.
function isSameOriginUrl(href) {
  try {
    return new URL(href).origin === self.location.origin;
  } catch {
    return false;
  }
}

// The session a push deep link names (`/?session=<id>`), or null.
function sessionFromUrl(href) {
  try {
    const id = new URL(href).searchParams.get("session");
    return id && /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

// The DeckTerm app itself is served at "/" (or /index.html).
function isAppWindow(client) {
  try {
    const url = new URL(client.url);
    return (
      url.origin === self.location.origin &&
      (url.pathname === "/" || url.pathname === "/index.html")
    );
  } catch {
    return false;
  }
}

// Prefer the window the owner is looking at: focused, then visible, then any
// app window. Other same-origin pages never get the message.
function pickAppWindow(clients) {
  const apps = clients.filter(isAppWindow);
  return (
    apps.find((client) => client.focused) ||
    apps.find((client) => client.visibilityState === "visible") ||
    apps[0] ||
    null
  );
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
      url: sameOriginUrl(payload.data?.url),
    },
    icon: "/app-icon.svg",
    badge: "/app-icon.svg",
    silent: payload.silent === true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// On click: focus an open DeckTerm window and, for a session deep link, post
// {type:"deckterm-open-session", terminalId} to it (no reload). With no app
// window open, open the deep link.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Notifications shown by an older worker may carry an unchecked path.
  let targetUrl = sameOriginUrl(event.notification.data?.url || "/");
  if (!isSameOriginUrl(targetUrl)) targetUrl = originRoot();
  const terminalId = sessionFromUrl(targetUrl);
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clients) => {
        const client = pickAppWindow(clients);
        if (client) {
          await client.focus();
          if (terminalId) {
            client.postMessage({ type: "deckterm-open-session", terminalId });
          } else if (
            "navigate" in client &&
            client.url !== targetUrl &&
            isSameOriginUrl(targetUrl)
          ) {
            await client.navigate(targetUrl);
          }
          return;
        }
        if (isSameOriginUrl(targetUrl)) {
          await self.clients.openWindow(targetUrl);
        }
      }),
  );
});
