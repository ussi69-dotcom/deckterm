# Web Push completion alerts

> **Plain-language guide.** A completion sound is played by the open DeckTerm page. A Web Push notification is delivered by the browser/operating system, so it can still arrive when that page is asleep or closed. Each phone or computer must be enabled separately, and iPhone/iPad users must run DeckTerm as a Home Screen web app.

## Goal

Make completed agent turns noticeable on desktop and mobile without exposing terminal contents on a lock screen or weakening DeckTerm's per-user isolation.

## Scope and decisions

- Keep the existing server-side, one-shot agent-turn completion signal as the only push trigger. Do not infer completion from process exit or replayed terminal output.
- Add a per-device **Enable push notifications** control. The browser permission prompt is shown only after that direct user action.
- Store each browser push subscription against the caller's canonical DeckTerm user ID. A caller can create or delete only their own subscriptions.
- Send a generic notification (`DeckTerm` / `Agent turn finished`) with no command, output, working directory, email, or project name.
- Use standards-based Web Push with a root-scoped service worker and VAPID keys supplied through environment variables. No third-party notification account is required.
- Keep page-level notifications only as a fallback on devices that are not subscribed, avoiding duplicate alerts.
- Add Normal / Loud / Maximum completion volume levels. Background notification sound remains controlled by the operating system.
- Do not cache application traffic in the service worker; it handles push and notification clicks only.

## Data and API

Migration 10 adds `push_subscriptions` with an opaque ID, canonical `user_id`, unique HTTPS endpoint, browser encryption keys, optional expiry, and timestamps. Endpoint and encryption keys are treated as secrets: they are never returned by list APIs, written to audit payloads, or included in logs.

Authenticated endpoints:

- `GET /api/notifications/push` returns only availability and the public VAPID key. Device enrollment state stays in the browser's own Push API subscription.
- `POST /api/notifications/push` validates and upserts a Push API subscription for the canonical non-disabled caller.
- `DELETE /api/notifications/push` deletes only a row matching both caller and endpoint.

The server removes a stale subscription only when its push service returns HTTP 404 or 410. Transient delivery errors leave it intact. Completion delivery is asynchronous and must never block terminal output.

## Browser behavior

`manifest.webmanifest` makes DeckTerm installable. `service-worker.js` always shows a visible notification for each push and focuses an existing DeckTerm window (or opens `/`) when clicked. The settings row shows one of: unavailable, permission blocked, ready to enable, enabled on this device, or action failed. iOS help explains the Home Screen requirement.

## Verification

- Migration creation and idempotency.
- Subscription input bounds, canonical ownership, cross-user create/delete protection, and no secret exposure.
- Delivery payload privacy, 404/410 cleanup, transient failure retention, and non-blocking dispatch.
- Service-worker push/click behavior and client enable/disable lifecycle.
- No duplicate page notification on an actively subscribed device.
- Existing one-shot agent completion and sound behavior stay green.
- Unit, TypeScript, syntax, formatting, and Playwright on dev port 4174 only.

## Delivery boundary

This work remains on the development branch unless the owner separately requests promotion. Production VAPID configuration and `Deploy Main` are a later, explicit release step.
