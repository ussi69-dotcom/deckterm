const { describe, expect, test } = require("bun:test");
const {
  base64UrlToUint8Array,
  PushNotificationManager,
} = require("./push-notifications.js");

const publicKey = Buffer.alloc(65, 7).toString("base64url");

function response(body, ok = true) {
  return {
    ok,
    json: async () => body,
  };
}

function createHarness({ postOk = true } = {}) {
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
  let currentSubscription = null;
  const registration = {
    pushManager: {
      getSubscription: async () => currentSubscription,
      subscribe: async (options) => {
        subscribeCalls += 1;
        calls.push(["subscribe", options]);
        currentSubscription = subscription;
        return subscription;
      },
    },
    showNotification: async (...args) => calls.push(["show", ...args]),
  };
  class MockNotification {
    static permission = "default";
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
    return response({ configured: true, publicKey });
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
});
