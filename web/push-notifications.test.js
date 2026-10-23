const { describe, expect, test } = require("bun:test");
const {
  base64UrlToUint8Array,
  subscriptionKeyMismatch,
  PushNotificationManager,
} = require("./push-notifications.js");

const publicKey = Buffer.alloc(65, 7).toString("base64url");

function response(body, ok = true) {
  return {
    ok,
    json: async () => body,
  };
}

// `existingKey`: the browser already holds a subscription made for this
// server key (bytes); `permission`: the notification permission at start.
function createHarness({
  postOk = true,
  config = null,
  existingKey = null,
  permission = "default",
} = {}) {
  const calls = [];
  let permissionRequests = 0;
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;
  const subscription = {
    endpoint: "https://push.example.test/device",
    toJSON: () => ({
      endpoint: "https://push.example.test/device",
      expirationTime: null,
      keys: {
        p256dh: Buffer.alloc(65, 1).toString("base64url"),
        auth: Buffer.alloc(16, 2).toString("base64url"),
      },
    }),
    unsubscribe: async () => {
      unsubscribeCalls += 1;
      return true;
    },
  };
  let currentSubscription = existingKey
    ? {
        endpoint: "https://push.example.test/old-device",
        options: { applicationServerKey: Uint8Array.from(existingKey).buffer },
        toJSON: () => ({ endpoint: "https://push.example.test/old-device" }),
        unsubscribe: async () => {
          unsubscribeCalls += 1;
          currentSubscription = null;
          return true;
        },
      }
    : null;
  const registration = {
    pushManager: {
      getSubscription: async () => currentSubscription,
      subscribe: async (options) => {
        subscribeCalls += 1;
        calls.push(["subscribe", options]);
        subscription.options = {
          applicationServerKey: options.applicationServerKey.buffer,
        };
        currentSubscription = subscription;
        return subscription;
      },
    },
    showNotification: async (...args) => calls.push(["show", ...args]),
  };
  class MockNotification {
    static permission = permission;
    static async requestPermission() {
      permissionRequests += 1;
      MockNotification.permission = "granted";
      return "granted";
    }
  }
  const fetchImpl = async (url, options = {}) => {
    calls.push([url, options.method || "GET", options.body || null]);
    if (options.method === "POST") {
      return response(postOk ? { ok: true } : { error: "save failed" }, postOk);
    }
    if (options.method === "DELETE") return response({ ok: true });
    return response(config || { configured: true, publicKey });
  };
  const manager = new PushNotificationManager({
    windowRef: { Notification: MockNotification, PushManager: class {} },
    navigatorRef: {
      serviceWorker: { register: async () => registration },
    },
    fetchImpl,
  });
  return {
    manager,
    calls,
    subscription,
    get permissionRequests() {
      return permissionRequests;
    },
    get subscribeCalls() {
      return subscribeCalls;
    },
    get unsubscribeCalls() {
      return unsubscribeCalls;
    },
  };
}

describe("PushNotificationManager", () => {
  test("converts the VAPID public key to browser bytes", () => {
    expect(base64UrlToUint8Array(publicKey)).toEqual(
      Uint8Array.from(Buffer.alloc(65, 7)),
    );
  });

  test("requests permission only during enable and persists the device subscription", async () => {
    const harness = createHarness();
    await harness.manager.initialize();
    expect(harness.permissionRequests).toBe(0);
    expect(harness.manager.getStatus().state).toBe("ready");

    expect(await harness.manager.enable()).toBe(true);
    expect(harness.permissionRequests).toBe(1);
    expect(harness.subscribeCalls).toBe(1);
    expect(harness.manager.getStatus().enabled).toBe(true);
    const post = harness.calls.find(
      (call) => call[0] === "/api/notifications/push" && call[1] === "POST",
    );
    expect(post).toBeDefined();
    expect(JSON.parse(post[2]).subscription.endpoint).toBe(
      harness.subscription.endpoint,
    );
  });

  test("a subscription made for an earlier server key is renewed at start without a prompt", async () => {
    // The VAPID key pair was rotated: the push service would refuse every
    // push for the old subscription while the page showed "enabled".
    const harness = createHarness({
      existingKey: Buffer.alloc(65, 9),
      permission: "granted",
    });
    await harness.manager.initialize();
    const deleted = harness.calls.find((call) => call[1] === "DELETE");
    expect(JSON.parse(deleted[2]).endpoint).toBe(
      "https://push.example.test/old-device",
    );
    expect(harness.unsubscribeCalls).toBe(1);
    expect(harness.subscribeCalls).toBe(1);
    const subscribe = harness.calls.find((call) => call[0] === "subscribe");
    expect(subscribe[1].applicationServerKey).toEqual(
      base64UrlToUint8Array(publicKey),
    );
    const post = harness.calls.find((call) => call[1] === "POST");
    expect(JSON.parse(post[2]).subscription.endpoint).toBe(
      harness.subscription.endpoint,
    );
    expect(harness.permissionRequests).toBe(0);
    expect(harness.manager.getStatus().state).toBe("enabled");
  });

  test("an old-key subscription without granted permission is dropped and Enable is offered", async () => {
    const harness = createHarness({ existingKey: Buffer.alloc(65, 9) });
    await harness.manager.initialize();
    expect(harness.unsubscribeCalls).toBe(1);
    expect(harness.subscribeCalls).toBe(0);
    expect(harness.permissionRequests).toBe(0);
    expect(harness.manager.getStatus().state).toBe("ready");

    expect(await harness.manager.enable()).toBe(true);
    expect(harness.subscribeCalls).toBe(1);
    expect(harness.manager.getStatus().state).toBe("enabled");
  });

  test("enable() replaces a subscription made for an earlier server key", async () => {
    const harness = createHarness({ existingKey: Buffer.alloc(65, 9) });
    expect(await harness.manager.enable()).toBe(true);
    expect(harness.unsubscribeCalls).toBe(1);
    expect(harness.subscribeCalls).toBe(1);
    expect(harness.manager.getStatus().enabled).toBe(true);
  });

  test("a subscription made for the current key is kept and re-saved", async () => {
    const harness = createHarness({
      existingKey: Buffer.alloc(65, 7),
      permission: "granted",
    });
    await harness.manager.initialize();
    expect(harness.calls.some((call) => call[1] === "DELETE")).toBe(false);
    expect(harness.unsubscribeCalls).toBe(0);
    expect(harness.subscribeCalls).toBe(0);
    expect(harness.calls.some((call) => call[1] === "POST")).toBe(true);
    expect(harness.manager.getStatus().state).toBe("enabled");
  });

  test("subscriptionKeyMismatch is false when the browser does not report the key", () => {
    expect(subscriptionKeyMismatch({ endpoint: "x" }, publicKey)).toBe(false);
    expect(
      subscriptionKeyMismatch(
        { options: { applicationServerKey: null } },
        publicKey,
      ),
    ).toBe(false);
    expect(
      subscriptionKeyMismatch(
        {
          options: {
            applicationServerKey: Uint8Array.from(Buffer.alloc(65, 7)).buffer,
          },
        },
        publicKey,
      ),
    ).toBe(false);
  });

  test("deletes the server row before unsubscribing locally", async () => {
    const harness = createHarness();
    await harness.manager.initialize();
    await harness.manager.enable();
    harness.calls.length = 0;

    expect(await harness.manager.disable()).toBe(true);
    expect(harness.calls[0][1]).toBe("DELETE");
    expect(harness.unsubscribeCalls).toBe(1);
    expect(harness.manager.getStatus().enabled).toBe(false);
  });

  test("rolls back a newly-created browser subscription when server persistence fails", async () => {
    const harness = createHarness({ postOk: false });
    await harness.manager.initialize();
    expect(await harness.manager.enable()).toBe(false);
    expect(harness.unsubscribeCalls).toBe(1);
    expect(harness.manager.hasActiveSubscription()).toBe(false);
    expect(harness.manager.getStatus().state).toBe("error");
  });

  test("an account without push rights is unavailable without touching the service worker", async () => {
    const harness = createHarness({
      config: { configured: false, publicKey: null, available: false },
    });
    const status = await harness.manager.initialize();
    expect(status.state).toBe("unavailable");
    expect(status.description).toBe(
      "Push notifications are not available for this account.",
    );
    expect(harness.calls.map((call) => call[0])).toEqual([
      "/api/notifications/push",
    ]);
  });

  test("suppresses page-level fallback when this device has a push subscription", async () => {
    const harness = createHarness();
    await harness.manager.initialize();
    await harness.manager.enable();
    expect(
      await harness.manager.showLocalFallback("Command finished", {
        body: "done",
      }),
    ).toBe(false);
    expect(harness.calls.some((call) => call[0] === "show")).toBe(false);
  });
});

describe("push service worker", () => {
  test("shows a visible generic notification and focuses an existing DeckTerm window", async () => {
    const handlers = new Map();
    const shown = [];
    let focused = 0;
    const selfRef = {
      location: { origin: "https://deckterm.example.test" },
      addEventListener: (type, handler) => handlers.set(type, handler),
      registration: {
        showNotification: async (...args) => shown.push(args),
      },
      clients: {
        matchAll: async () => [
          {
            url: "https://deckterm.example.test/",
            focus: async () => {
              focused += 1;
            },
            navigate: async () => {},
          },
        ],
        openWindow: async () => {},
      },
    };
    const source = await Bun.file(
      new URL("./service-worker.js", import.meta.url),
    ).text();
    new Function("self", "URL", source)(selfRef, URL);

    let pushPromise;
    handlers.get("push")({
      data: {
        json: () => ({
          title: "DeckTerm",
          body: "Agent turn finished",
          data: { url: "/" },
        }),
      },
      waitUntil: (promise) => {
        pushPromise = promise;
      },
    });
    await pushPromise;
    expect(shown[0][0]).toBe("DeckTerm");
    expect(shown[0][1].body).toBe("Agent turn finished");
    expect(shown[0][1].silent).toBe(false);

    let clickPromise;
    handlers.get("notificationclick")({
      notification: { close: () => {}, data: { url: "/" } },
      waitUntil: (promise) => {
        clickPromise = promise;
      },
    });
    await clickPromise;
    expect(focused).toBe(1);
  });

  function loadWorker({ clients }) {
    const handlers = new Map();
    const shown = [];
    const opened = [];
    const selfRef = {
      location: { origin: "https://deckterm.example.test" },
      addEventListener: (type, handler) => handlers.set(type, handler),
      registration: {
        showNotification: async (...args) => shown.push(args),
      },
      clients: {
        matchAll: async () => clients,
        openWindow: async (url) => {
          opened.push(url);
        },
      },
    };
    return Bun.file(new URL("./service-worker.js", import.meta.url))
      .text()
      .then((source) => {
        new Function("self", "URL", source)(selfRef, URL);
        return { handlers, shown, opened };
      });
  }

  async function click(handlers, url) {
    let clickPromise;
    handlers.get("notificationclick")({
      notification: { close: () => {}, data: { url } },
      waitUntil: (promise) => {
        clickPromise = promise;
      },
    });
    await clickPromise;
  }

  const SESSION = "4b6f3c1e-8f2a-4d6b-9c1e-2a3b4c5d6e7f";

  test("a session deep link is posted to an open window instead of navigating", async () => {
    const messages = [];
    const navigations = [];
    let focused = 0;
    const { handlers } = await loadWorker({
      clients: [
        {
          url: "https://deckterm.example.test/",
          focus: async () => {
            focused += 1;
          },
          navigate: async (url) => navigations.push(url),
          postMessage: (message) => messages.push(message),
        },
      ],
    });
    await click(handlers, `/?session=${SESSION}`);
    expect(focused).toBe(1);
    expect(messages).toEqual([
      { type: "deckterm-open-session", terminalId: SESSION },
    ]);
    expect(navigations).toEqual([]);
  });

  test("with no window open the deep link opens in a new window", async () => {
    const { handlers, opened } = await loadWorker({ clients: [] });
    await click(handlers, `/?session=${SESSION}`);
    expect(opened).toEqual([
      `https://deckterm.example.test/?session=${SESSION}`,
    ]);
  });

  const ORIGIN = "https://deckterm.example.test";

  test("only a same-origin URL is accepted, stored as an absolute URL", async () => {
    const { handlers, shown, opened } = await loadWorker({ clients: [] });
    for (const url of [
      "//evil.example/",
      "/\\evil.example/",
      "https://evil.example/",
      "javascript:alert(1)",
      42,
    ]) {
      let pushPromise;
      handlers.get("push")({
        data: { json: () => ({ data: { url } }) },
        waitUntil: (promise) => {
          pushPromise = promise;
        },
      });
      await pushPromise;
      await click(handlers, url);
    }
    for (const [, options] of shown) {
      expect(options.data.url).toBe(`${ORIGIN}/`);
    }
    expect(opened.length).toBe(5);
    expect(opened.every((url) => url === `${ORIGIN}/`)).toBe(true);
  });

  test("a path that normalizes to //host stays on the origin (push and click)", async () => {
    const tricky = [
      "/x/..//evil.example/",
      "/x/../\\evil.example/",
      "/%2e%2e//evil.example/",
      "/./x/../..//evil.example/?session=abc",
    ];
    const navigations = [];
    const { handlers, shown, opened } = await loadWorker({ clients: [] });
    for (const url of tricky) {
      let pushPromise;
      handlers.get("push")({
        data: { json: () => ({ data: { url } }) },
        waitUntil: (promise) => {
          pushPromise = promise;
        },
      });
      await pushPromise;
      // An older notification whose data never went through the push
      // handler: the click path must check the final URL itself.
      await click(handlers, url);
    }
    for (const [, options] of shown) {
      expect(new URL(options.data.url).origin).toBe(ORIGIN);
    }
    expect(opened.length).toBe(tricky.length);
    for (const url of opened) expect(new URL(url).origin).toBe(ORIGIN);

    // The same with an open app window that gets navigated.
    const app = await loadWorker({
      clients: [
        {
          url: `${ORIGIN}/`,
          focused: true,
          focus: async () => {},
          navigate: async (url) => navigations.push(url),
          postMessage: () => {},
        },
      ],
    });
    for (const url of tricky) await click(app.handlers, url);
    expect(navigations.length).toBeGreaterThan(0);
    for (const url of navigations) expect(new URL(url).origin).toBe(ORIGIN);
    expect(app.opened).toEqual([]);
  });

  function windowClient(url, extra = {}) {
    const client = {
      url,
      focused: false,
      visibilityState: "hidden",
      focusCalls: 0,
      messages: [],
      navigations: [],
      focus: async () => {
        client.focusCalls += 1;
      },
      navigate: async (to) => client.navigations.push(to),
      postMessage: (message) => client.messages.push(message),
      ...extra,
    };
    return client;
  }

  test("the deep link goes to the focused DeckTerm app window, not the first same-origin page", async () => {
    const helpPage = windowClient(`${ORIGIN}/help.html`, { focused: true });
    const otherOrigin = windowClient("https://other.example/", {
      focused: true,
    });
    const background = windowClient(`${ORIGIN}/`);
    const visible = windowClient(`${ORIGIN}/?debug=1`, {
      visibilityState: "visible",
    });
    const focused = windowClient(`${ORIGIN}/index.html`, { focused: true });
    const { handlers, opened } = await loadWorker({
      clients: [helpPage, otherOrigin, background, visible, focused],
    });
    await click(handlers, `/?session=${SESSION}`);
    expect(focused.messages).toEqual([
      { type: "deckterm-open-session", terminalId: SESSION },
    ]);
    expect(focused.focusCalls).toBe(1);
    for (const client of [helpPage, otherOrigin, background, visible]) {
      expect(client.messages).toEqual([]);
      expect(client.focusCalls).toBe(0);
    }
    expect(opened).toEqual([]);
  });

  test("without a focused app window a visible one wins, then any app window", async () => {
    const background = windowClient(`${ORIGIN}/`);
    const visible = windowClient(`${ORIGIN}/`, { visibilityState: "visible" });
    let worker = await loadWorker({ clients: [background, visible] });
    await click(worker.handlers, `/?session=${SESSION}`);
    expect(visible.messages.length).toBe(1);
    expect(background.messages.length).toBe(0);

    const only = windowClient(`${ORIGIN}/`);
    worker = await loadWorker({ clients: [only] });
    await click(worker.handlers, `/?session=${SESSION}`);
    expect(only.messages.length).toBe(1);
  });

  test("same-origin pages that are not the app get no message; the deep link opens instead", async () => {
    const helpPage = windowClient(`${ORIGIN}/help.html`, { focused: true });
    const { handlers, opened } = await loadWorker({ clients: [helpPage] });
    await click(handlers, `/?session=${SESSION}`);
    expect(helpPage.messages).toEqual([]);
    expect(helpPage.focusCalls).toBe(0);
    expect(opened).toEqual([`${ORIGIN}/?session=${SESSION}`]);
  });
});
