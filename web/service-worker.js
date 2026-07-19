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
      url:
        typeof payload.data?.url === "string" &&
        payload.data.url.startsWith("/")
          ? payload.data.url
          : "/",
    },
    icon: "/app-icon.svg",
    badge: "/app-icon.svg",
    silent: payload.silent === true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const requestedUrl = event.notification.data?.url || "/";
  const targetUrl = new URL(requestedUrl, self.location.origin).href;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clients) => {
        for (const client of clients) {
          if (new URL(client.url).origin !== self.location.origin) continue;
          await client.focus();
          if ("navigate" in client && client.url !== targetUrl) {
            await client.navigate(targetUrl);
          }
          return;
        }
        await self.clients.openWindow(targetUrl);
      }),
  );
});
