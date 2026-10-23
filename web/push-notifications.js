// Per-device standards-based Web Push lifecycle. Permission is requested only
// from enable(), which is called by a direct Settings interaction.

function base64UrlToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

// True when `subscription` was made for a different server key than
// `publicKey` (the VAPID key pair was rotated): the push service refuses every
// push signed with the new key for it, while the page would still show
// "enabled". False when the browser does not report the key.
function subscriptionKeyMismatch(subscription, publicKey) {
  const key = subscription?.options?.applicationServerKey;
  if (!key || !publicKey) return false;
  const current = base64UrlToUint8Array(publicKey);
  const stored = new Uint8Array(key);
  if (stored.length !== current.length) return true;
  return stored.some((byte, index) => byte !== current[index]);
}

class PushNotificationManager {
  constructor({ windowRef, navigatorRef, fetchImpl, onChange } = {}) {
    this.windowRef =
      windowRef || (typeof window !== "undefined" ? window : null);
    this.navigatorRef =
      navigatorRef || (typeof navigator !== "undefined" ? navigator : null);
    this.fetchImpl =
      fetchImpl ||
      (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    this.onChange = typeof onChange === "function" ? onChange : () => {};
    this.registration = null;
    this.subscription = null;
    this.config = null;
    this.state = "loading";
    this.error = null;
  }

  supported() {
    return Boolean(
      this.windowRef?.Notification &&
      this.navigatorRef?.serviceWorker &&
      this.windowRef?.PushManager &&
      this.fetchImpl,
    );
  }

  setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.onChange(this.getStatus());
  }

  getStatus() {
    const permission = this.windowRef?.Notification?.permission || "default";
    const descriptions = {
      loading: "Checking this device…",
      unsupported: "This browser does not support Web Push.",
      unavailable:
        this.config?.available === false
          ? "Push notifications are not available for this account."
          : "The DeckTerm server has not been configured with push keys yet.",
      blocked:
        "Notifications are blocked in browser or system settings for DeckTerm.",
      ready:
        "Send an operating-system notification when an agent or command finishes. Each device is enabled separately.",
      enabled:
        "Enabled on this device. On iPhone/iPad, DeckTerm must remain installed as a Home Screen web app.",
      error: this.error || "Push notification setup failed. Try again.",
    };
    return {
      state: this.state,
      supported: this.supported(),
      configured: Boolean(this.config?.configured && this.config?.publicKey),
      permission,
      enabled: Boolean(this.subscription),
      busy: this.state === "loading",
      description: descriptions[this.state] || descriptions.error,
    };
  }

  async loadConfig() {
    const response = await this.fetchImpl("/api/notifications/push");
    if (!response.ok) throw new Error("Push configuration is unavailable.");
    const body = await response.json();
    this.config = {
      // false: the server answered for an actor without push rights.
      available: body?.available !== false,
      configured: Boolean(body?.configured),
      publicKey:
        typeof body?.publicKey === "string" && body.publicKey
          ? body.publicKey
          : null,
    };
    return this.config;
  }

  // Drops a subscription made for an earlier server key: the server row
  // first (as disable() does), then the browser's. Best effort: a failure
  // leaves a row whose pushes the push service refuses.
  async dropStaleSubscription(subscription) {
    await this.fetchImpl("/api/notifications/push", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    }).catch(() => null);
    await subscription.unsubscribe().catch(() => false);
  }

  async subscribeWithKey(registration, publicKey) {
    return registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(publicKey),
    });
  }

  async ensureRegistration() {
    if (this.registration) return this.registration;
    this.registration = await this.navigatorRef.serviceWorker.register(
      "/service-worker.js",
      { scope: "/" },
    );
    return this.registration;
  }

  async persistSubscription(subscription) {
    const response = await this.fetchImpl("/api/notifications/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body?.error || "Could not save this push subscription.");
    }
  }

  async initialize() {
    if (!this.supported()) {
      this.setState("unsupported");
      return this.getStatus();
    }
    this.setState("loading");
    try {
      const config = await this.loadConfig();
      if (!config.configured || !config.publicKey) {
        this.setState("unavailable");
        return this.getStatus();
      }
      if (this.windowRef.Notification.permission === "denied") {
        this.setState("blocked");
        return this.getStatus();
      }
      const registration = await this.ensureRegistration();
      this.subscription = await registration.pushManager.getSubscription();
      if (
        this.subscription &&
        subscriptionKeyMismatch(this.subscription, config.publicKey)
      ) {
        // The server key was rotated. With permission granted the
        // subscription is renewed with the current key without a prompt;
        // otherwise the device is offered Enable again (no prompt here:
        // permission is asked only from enable()).
        await this.dropStaleSubscription(this.subscription);
        this.subscription =
          this.windowRef.Notification.permission === "granted"
            ? await this.subscribeWithKey(registration, config.publicKey).catch(
                () => null,
              )
            : null;
      }
      if (this.subscription) {
        // Heal a server row lost to a restore or database rollback.
        await this.persistSubscription(this.subscription);
        this.setState("enabled");
      } else {
        this.setState("ready");
      }
    } catch (error) {
      this.setState(
        "error",
        error instanceof Error ? error.message : "Push setup failed.",
      );
    }
    return this.getStatus();
  }

  async enable() {
    if (!this.supported()) {
      this.setState("unsupported");
      return false;
    }
    this.setState("loading");
    let created = null;
    try {
      const config = this.config || (await this.loadConfig());
      if (!config.configured || !config.publicKey) {
        this.setState("unavailable");
        return false;
      }
      const permission = await this.windowRef.Notification.requestPermission();
      if (permission !== "granted") {
        this.setState(permission === "denied" ? "blocked" : "ready");
        return false;
      }
      const registration = await this.ensureRegistration();
      let subscription = await registration.pushManager.getSubscription();
      if (
        subscription &&
        subscriptionKeyMismatch(subscription, config.publicKey)
      ) {
        await this.dropStaleSubscription(subscription);
        subscription = null;
      }
      if (!subscription) {
        subscription = await this.subscribeWithKey(
          registration,
          config.publicKey,
        );
        created = subscription;
      }
      await this.persistSubscription(subscription);
      this.subscription = subscription;
      this.setState("enabled");
      return true;
    } catch (error) {
      if (created) await created.unsubscribe().catch(() => false);
      this.subscription = null;
      this.setState(
        "error",
        error instanceof Error ? error.message : "Push setup failed.",
      );
      return false;
    }
  }

  async disable() {
    this.setState("loading");
    try {
      const registration = await this.ensureRegistration();
      const subscription =
        this.subscription || (await registration.pushManager.getSubscription());
      if (subscription) {
        const response = await this.fetchImpl("/api/notifications/push", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        if (!response.ok) {
          throw new Error("Could not disable push on the server.");
        }
        await subscription.unsubscribe();
      }
      this.subscription = null;
      this.setState("ready");
      return true;
    } catch (error) {
      this.setState(
        "error",
        error instanceof Error ? error.message : "Could not disable push.",
      );
      return false;
    }
  }

  async setEnabled(enabled) {
    return enabled ? this.enable() : this.disable();
  }

  hasActiveSubscription() {
    return Boolean(this.subscription);
  }

  async showLocalFallback(title, options) {
    if (this.hasActiveSubscription()) return false;
    if (this.windowRef?.Notification?.permission !== "granted") return false;
    try {
      // Desktop browsers support the page constructor and it keeps existing
      // behavior/testability. Mobile browsers may reject it, then the service
      // worker registration provides the standards-based fallback.
      new this.windowRef.Notification(title, options);
      return true;
    } catch {
      try {
        const registration = await this.ensureRegistration();
        await registration.showNotification(title, options);
        return true;
      } catch {
        return false;
      }
    }
  }
}

const PushNotifications = {
  base64UrlToUint8Array,
  subscriptionKeyMismatch,
  PushNotificationManager,
};

if (typeof window !== "undefined") window.PushNotifications = PushNotifications;
if (typeof module !== "undefined" && module.exports) {
  module.exports = PushNotifications;
}
