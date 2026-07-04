// B3-S5 — admin-only "Users" settings category (frontend).
//
// Backend surfaces (B3-S3, already live on this branch): GET/POST /api/users,
// PATCH /api/users/:id, POST /api/users/:id/review, GET/POST /api/grants,
// DELETE /api/grants/:id. (POST /api/grants/review — orphan-principal review —
// is out of scope here: it isn't part of the { currentUser, users,
// grantsByUser } model this view renders; it has no UI path in S5.)
//
// This module is deliberately split into pure builders (DOM-free, unit-tested
// without a browser) and a thin browser-only DOM controller that wires them to
// fetch + the SettingsManager host (web/app.js). The controller never sends
// the acting user's identity to the server — every mutation targets an id
// read from already-rendered data; the actor is always server-derived from
// the request's auth context.
//
// Invariants mirrored from the plan (docs/plans/2026-07-03-b3-user-provisioning-roles-revocation.md
// §7/§9.4), enforced here defense-in-depth (the API is the real gate):
//   - the "Users" category itself is gated by shouldShowUsersCategory() in
//     app.js — non-null user, role owner|admin, disabled === false;
//   - owner rows can never be role-changed / disabled / reviewed via this UI;
//   - admin rows can only be role-changed / disabled / reviewed / grant-edited
//     when the acting user is owner (mirrors the server's owner_required gate);
//   - only owner sees the invite-as-admin option and the per-row review
//     actions;
//   - no capability/resource control ever offers a wildcard ('*') value —
//     the server rejects wildcard grants unconditionally (B3 §4 Codex #2).

// ── Shared HTML escaper (browser global OR CommonJS under bun) ──────────────

function resolveEscapeHtml() {
  if (typeof window !== "undefined" && window.HtmlEscape?.escapeHtml) {
    return window.HtmlEscape.escapeHtml;
  }
  if (typeof require !== "undefined") {
    try {
      return require("./html-escape").escapeHtml;
    } catch {
      // fall through to the inline copy
    }
  }
  return (text) =>
    String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
}

function esc(text) {
  return resolveEscapeHtml()(text);
}

// The five real scoped-grant capabilities (B1/B3). No wildcard is ever
// offered here — the server rejects '*' in resourceType/resourceId for every
// target, and the UI must not pretend otherwise.
const CAPABILITY_OPTIONS = [
  "terminal.create",
  "terminal.attach",
  "terminal.write",
  "terminal.manage",
  "root.use",
];

// ── Pure gate: is the "Users" category visible at all? ──────────────────────
//
// Plan §7 (Codex #15): visible only when `foundation/status.auth.user` is
// non-null, role is owner or admin, AND disabled === false. Any other shape
// (null user, member role, disabled admin, malformed status) hides it.
function shouldShowUsersCategory(status) {
  const user = status && typeof status === "object" ? status.auth?.user : null;
  if (!user || typeof user !== "object") return false;
  if (user.role !== "owner" && user.role !== "admin") return false;
  if (user.disabled !== false) return false;
  return true;
}

// ── Pure view-model builders (DOM-free, unit-tested) ─────────────────────────

// Mirrors the server's owner_required gate (plan §9.4): a mutation targeting
// an owner is never allowed via the API; a mutation targeting an admin
// requires the acting user to be owner; a member target is manageable by
// either owner or admin.
function canManageTarget(currentUser, targetUser) {
  if (!currentUser || !targetUser) return false;
  if (targetUser.role === "owner") return false;
  if (targetUser.role === "admin") return currentUser.role === "owner";
  return true;
}

// Per-user row: flags decide which controls the row renders, computed from
// the same precedence the backend enforces so the UI never dangles an
// affordance the API would reject anyway.
function buildUserRowView(user, currentUser, grants) {
  const isOwnerActor = currentUser?.role === "owner";
  const isTargetOwner = user.role === "owner";
  const managed = canManageTarget(currentUser, user);
  const needsReview =
    user.role === "admin" && !isTargetOwner && !user.multiuserReviewedAt;
  return {
    id: user.id,
    email: user.email || "",
    displayName: user.displayName || "",
    role: user.role,
    disabled: Boolean(user.disabled),
    liveTerminalCount:
      typeof user.liveTerminalCount === "number" ? user.liveTerminalCount : 0,
    needsReview: Boolean(needsReview),
    // Role select + disable button: hidden for owner rows always; for admin
    // rows, only the owner actor sees them; member rows are always actionable
    // by owner or admin.
    showRoleSelect: !isTargetOwner && managed,
    // The role select's option list is owner-gated independent of the
    // target's current role: the server's PATCH /api/users/:id gate treats
    // `wantsRole === 'admin'` as touching the admin surface even for a
    // member target (promotion requires owner, not just management of that
    // row) — so a non-owner admin managing a member row must not be offered
    // "admin" as a destination, only a same-tier no-op ("member").
    roleOptions: isOwnerActor ? ["member", "admin"] : ["member"],
    showDisableButton: !isTargetOwner && managed,
    // Review actions are owner-only AND only meaningful while unreviewed.
    showReviewActions: isOwnerActor && needsReview,
    // Grant add/revoke follows the same owner_required gate as user mutation.
    canManageGrants: managed,
    grants: Array.isArray(grants) ? grants : [],
  };
}

// Top-level view model: { currentUser, users, grantsByUser } -> a render-ready
// structure. Pure — no DOM, no fetch. `grantsByUser` maps userId -> grant[].
function buildUsersView({ currentUser, users, grantsByUser } = {}) {
  const list = Array.isArray(users) ? users : [];
  const isOwner = currentUser?.role === "owner";
  return {
    isOwner,
    canInvite: Boolean(currentUser),
    // The admin role option is owner-only (plan §7): non-owner admins can
    // only invite members.
    inviteRoleOptions: isOwner ? ["member", "admin"] : ["member"],
    capabilityOptions: CAPABILITY_OPTIONS.slice(),
    rows: list.map((u) =>
      buildUserRowView(u, currentUser, grantsByUser?.[u.id]),
    ),
  };
}

// ── Pure HTML renderers (DOM-free, unit-tested via string assertions) ───────

function inviteFormHtml(model) {
  if (!model.canInvite) return "";
  const roleOptions = model.inviteRoleOptions
    .map((r) => `<option value="${esc(r)}">${esc(r)}</option>`)
    .join("");
  return `
    <form class="users-admin-invite" data-users-admin-form="invite">
      <h3 class="users-admin-section-title">Invite user</h3>
      <div class="users-admin-invite-grid">
        <label class="users-admin-field">Provider
          <input type="text" name="provider" class="users-admin-input" value="cloudflare_access" readonly />
        </label>
        <label class="users-admin-field">Issuer
          <input type="text" name="issuer" class="users-admin-input" placeholder="CF Access team domain" required />
        </label>
        <label class="users-admin-field">Subject
          <input type="text" name="subject" class="users-admin-input" required />
        </label>
        <label class="users-admin-field">Email
          <input type="email" name="email" class="users-admin-input" />
        </label>
        <label class="users-admin-field">Display name
          <input type="text" name="displayName" class="users-admin-input" />
        </label>
        <label class="users-admin-field">Role
          <select name="role" class="users-admin-input">${roleOptions}</select>
        </label>
      </div>
      <button type="submit" class="users-admin-btn primary">Invite</button>
    </form>`;
}

function grantsSectionHtml(row) {
  const items = row.grants.length
    ? row.grants
        .map(
          (g) => `
      <li class="users-admin-grant-item" data-grant-id="${esc(g.id)}">
        <span class="users-admin-grant-label">${esc(g.capability)} &middot; ${esc(g.resourceType)}/${esc(g.resourceId)}</span>
        ${
          row.canManageGrants
            ? `<button type="button" class="users-admin-btn small danger" data-grant-action="revoke" data-grant-id="${esc(g.id)}" data-user-id="${esc(row.id)}">Revoke</button>`
            : ""
        }
      </li>`,
        )
        .join("")
    : '<li class="users-admin-empty">No scoped grants</li>';

  const addForm = row.canManageGrants
    ? `
    <form class="users-admin-grant-add" data-users-admin-form="grant-add" data-user-id="${esc(row.id)}">
      <select name="capability" class="users-admin-input small">
        ${CAPABILITY_OPTIONS.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
      </select>
      <input type="text" name="resourceType" class="users-admin-input small" placeholder="resource type" required />
      <input type="text" name="resourceId" class="users-admin-input small" placeholder="resource id" required />
      <button type="submit" class="users-admin-btn small">Add grant</button>
    </form>`
    : "";

  return `
    <div class="users-admin-grants">
      <ul class="users-admin-grants-list">${items}</ul>
      ${addForm}
    </div>`;
}

function userRowHtml(row) {
  const reviewBadge = row.needsReview
    ? '<span class="users-admin-badge warn" data-testid="needs-review">Needs review</span>'
    : "";
  const roleCell = row.showRoleSelect
    ? `<select class="users-admin-input" data-user-action="role" data-user-id="${esc(row.id)}" name="role">
         ${row.roleOptions
           .map(
             (r) =>
               `<option value="${esc(r)}"${r === row.role ? " selected" : ""}>${esc(r)}</option>`,
           )
           .join("")}
       </select>`
    : `<span class="users-admin-role-badge users-admin-role-${esc(row.role)}">${esc(row.role)}</span>`;
  const disableBtn = row.showDisableButton
    ? `<button type="button" class="users-admin-btn small${row.disabled ? "" : " danger"}" data-user-action="toggle-disabled" data-user-id="${esc(row.id)}">${row.disabled ? "Enable" : "Disable"}</button>`
    : "";
  const reviewButtons = row.showReviewActions
    ? `<div class="users-admin-review-actions">
         <button type="button" class="users-admin-btn small" data-user-review-action="keep_admin" data-user-id="${esc(row.id)}">Keep admin</button>
         <button type="button" class="users-admin-btn small" data-user-review-action="make_member" data-user-id="${esc(row.id)}">Make member</button>
         <button type="button" class="users-admin-btn small danger" data-user-review-action="disable" data-user-id="${esc(row.id)}">Disable</button>
       </div>`
    : "";
  const identityLabel = row.email || row.displayName || row.id;

  return `
    <tr class="users-admin-row" data-user-row="${esc(row.id)}" data-user-role="${esc(row.role)}">
      <td>
        <div class="users-admin-user-cell">
          <span class="users-admin-user-email" title="${esc(identityLabel)}">${esc(identityLabel)}</span>
          ${row.displayName && row.email ? `<span class="users-admin-user-name">${esc(row.displayName)}</span>` : ""}
        </div>
      </td>
      <td class="users-admin-role-cell">${roleCell}${reviewBadge}</td>
      <td>${row.disabled ? '<span class="users-admin-badge danger">Disabled</span>' : '<span class="users-admin-badge ok">Active</span>'}</td>
      <td class="users-admin-count-cell">${row.liveTerminalCount}</td>
      <td class="users-admin-actions-cell">${disableBtn}${reviewButtons}</td>
    </tr>
    <tr class="users-admin-grants-row">
      <td colspan="5">${grantsSectionHtml(row)}</td>
    </tr>`;
}

// Top-level panel renderer: view model (from buildUsersView) + transient
// loading/error state -> a full HTML string for the panel. Pure/DOM-free.
function usersAdminHtml(model, state = {}) {
  const errorHtml = state.error
    ? `<p class="users-admin-error" role="alert">${esc(state.error)}</p>`
    : "";
  const loadingHtml = state.loading
    ? '<p class="users-admin-loading">Loading&hellip;</p>'
    : "";
  const rowsHtml = model.rows.length
    ? model.rows.map(userRowHtml).join("")
    : '<tr><td colspan="5" class="users-admin-empty">No users</td></tr>';

  return `
    ${errorHtml}
    ${inviteFormHtml(model)}
    ${loadingHtml}
    <table class="users-admin-table">
      <thead>
        <tr><th>User</th><th>Role</th><th>Status</th><th>Live terminals</th><th>Actions</th></tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
}

// ── Thin API client (fetch wrappers over the seven S3 endpoints) ────────────
//
// Every wrapper surfaces the server's `reason` field on failure (thrown as
// `.reason` on the Error) so the controller can show an actionable message.
// None of these ever include the acting user's identity — targets are always
// ids read from already-rendered data; the actor is resolved server-side.

async function apiRequest(fetchImpl, path, options = {}) {
  const fn =
    fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
  if (!fn) throw new Error("fetch_unavailable");
  const hasBody = options.body !== undefined;
  const res = await fn(path, {
    method: options.method || "GET",
    headers: hasBody ? { "Content-Type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const reason = (body && (body.reason || body.error)) || null;
    const err = new Error(reason || `request_failed_${res.status}`);
    err.reason = reason;
    err.status = res.status;
    throw err;
  }
  return body;
}

function listUsers(fetchImpl) {
  return apiRequest(fetchImpl, "/api/users");
}

function inviteUser(fetchImpl, payload) {
  return apiRequest(fetchImpl, "/api/users", { method: "POST", body: payload });
}

function updateUser(fetchImpl, userId, payload) {
  return apiRequest(fetchImpl, `/api/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: payload,
  });
}

function reviewUser(fetchImpl, userId, decision) {
  return apiRequest(
    fetchImpl,
    `/api/users/${encodeURIComponent(userId)}/review`,
    { method: "POST", body: { decision } },
  );
}

function listGrants(fetchImpl, userId) {
  return apiRequest(
    fetchImpl,
    userId ? `/api/grants?userId=${encodeURIComponent(userId)}` : "/api/grants",
  );
}

function createGrant(fetchImpl, payload) {
  return apiRequest(fetchImpl, "/api/grants", {
    method: "POST",
    body: payload,
  });
}

function revokeGrant(fetchImpl, grantId) {
  return apiRequest(fetchImpl, `/api/grants/${encodeURIComponent(grantId)}`, {
    method: "DELETE",
  });
}

// ── DOM controller (browser-only) ────────────────────────────────────────────
//
// Options:
//   document        the DOM document (defaults to global document)
//   fetchImpl       fetch function (defaults to window.fetch)
//   getCurrentUser  () => { id, role, disabled } | null — the resolved actor
class UsersAdminController {
  constructor(options = {}) {
    this.doc =
      options.document || (typeof document !== "undefined" ? document : null);
    this.fetchImpl =
      options.fetchImpl ||
      (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    this.getCurrentUserFn =
      typeof options.getCurrentUser === "function"
        ? options.getCurrentUser
        : () => options.currentUser || null;

    this.root = null;
    this.container = null;
    this.users = [];
    this.grantsByUser = {};
    this.loading = false;
    this.error = null;
    this._bound = false;
  }

  get currentUser() {
    return this.getCurrentUserFn();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  mount(container) {
    if (!container || !this.doc) return;
    this.container = container;
    if (!this.root) {
      this.root = this.doc.createElement("div");
      this.root.className = "users-admin-panel";
    }
    if (this.root.parentElement !== container) {
      container.appendChild(this.root);
    }
    if (!this._bound) {
      this.bindEvents();
      this._bound = true;
    }
    this.render();
    void this.refresh();
  }

  unmount() {
    if (this.root && this.root.parentElement) {
      this.root.parentElement.removeChild(this.root);
    }
    this.root = null;
    this.container = null;
    this._bound = false;
  }

  // ── Data ────────────────────────────────────────────────────────────────────

  async refresh() {
    this.loading = true;
    this.error = null;
    this.render();
    try {
      const usersRes = await listUsers(this.fetchImpl);
      const users = Array.isArray(usersRes?.users) ? usersRes.users : [];
      const grantsByUser = {};
      await Promise.all(
        users.map(async (u) => {
          try {
            const g = await listGrants(this.fetchImpl, u.id);
            grantsByUser[u.id] = Array.isArray(g?.grants) ? g.grants : [];
          } catch {
            grantsByUser[u.id] = [];
          }
        }),
      );
      this.users = users;
      this.grantsByUser = grantsByUser;
    } catch (err) {
      this.error = err?.reason || err?.message || "load_failed";
    } finally {
      this.loading = false;
      this.render();
    }
  }

  // Runs a mutation, re-fetches on success, and surfaces `.reason` on failure
  // without throwing into the caller (event handlers never throw).
  async runAction(fn) {
    this.error = null;
    try {
      await fn();
      await this.refresh();
    } catch (err) {
      this.error = err?.reason || err?.message || "action_failed";
      this.render();
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  render() {
    if (!this.root) return;
    const model = buildUsersView({
      currentUser: this.currentUser,
      users: this.users,
      grantsByUser: this.grantsByUser,
    });
    this.root.innerHTML = usersAdminHtml(model, {
      loading: this.loading,
      error: this.error,
    });
  }

  // ── Events ───────────────────────────────────────────────────────────────────

  bindEvents() {
    this.root.addEventListener("submit", (e) => void this.onSubmit(e));
    this.root.addEventListener("click", (e) => void this.onClick(e));
    this.root.addEventListener("change", (e) => void this.onChange(e));
  }

  confirmAction(message) {
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      return window.confirm(message);
    }
    return true;
  }

  async onSubmit(e) {
    const inviteForm = e.target.closest?.('[data-users-admin-form="invite"]');
    if (inviteForm) {
      e.preventDefault();
      await this.handleInvite(inviteForm);
      return;
    }
    const grantForm = e.target.closest?.('[data-users-admin-form="grant-add"]');
    if (grantForm) {
      e.preventDefault();
      await this.handleGrantAdd(grantForm);
    }
  }

  async onChange(e) {
    const roleSelect = e.target.closest?.('[data-user-action="role"]');
    if (!roleSelect) return;
    const userId = roleSelect.dataset.userId;
    const role = roleSelect.value;
    await this.runAction(() => updateUser(this.fetchImpl, userId, { role }));
  }

  async onClick(e) {
    const disableBtn = e.target.closest?.(
      '[data-user-action="toggle-disabled"]',
    );
    if (disableBtn) {
      const userId = disableBtn.dataset.userId;
      const user = this.users.find((u) => u.id === userId);
      const nextDisabled = !(user && user.disabled);
      const verb = nextDisabled ? "disable" : "enable";
      if (!this.confirmAction(`Are you sure you want to ${verb} this user?`))
        return;
      await this.runAction(() =>
        updateUser(this.fetchImpl, userId, { disabled: nextDisabled }),
      );
      return;
    }

    const reviewBtn = e.target.closest?.("[data-user-review-action]");
    if (reviewBtn) {
      const userId = reviewBtn.dataset.userId;
      const decision = reviewBtn.dataset.userReviewAction;
      if (
        decision === "disable" &&
        !this.confirmAction("Disable this admin?")
      ) {
        return;
      }
      await this.runAction(() => reviewUser(this.fetchImpl, userId, decision));
      return;
    }

    const revokeBtn = e.target.closest?.('[data-grant-action="revoke"]');
    if (revokeBtn) {
      const grantId = revokeBtn.dataset.grantId;
      if (!this.confirmAction("Revoke this grant?")) return;
      await this.runAction(() => revokeGrant(this.fetchImpl, grantId));
    }
  }

  async handleInvite(form) {
    const els = form.elements;
    const payload = {
      provider: "cloudflare_access",
      issuer: els.issuer?.value?.trim() || "",
      subject: els.subject?.value?.trim() || "",
      email: els.email?.value?.trim() || undefined,
      displayName: els.displayName?.value?.trim() || undefined,
      role: els.role?.value || "member",
    };
    await this.runAction(() => inviteUser(this.fetchImpl, payload));
    if (this.doc.contains?.(form) === false || !this.error) form.reset?.();
  }

  async handleGrantAdd(form) {
    const userId = form.dataset.userId;
    const els = form.elements;
    const payload = {
      userId,
      capability: els.capability?.value,
      resourceType: els.resourceType?.value?.trim() || "",
      resourceId: els.resourceId?.value?.trim() || "",
    };
    await this.runAction(() => createGrant(this.fetchImpl, payload));
  }
}

// ── Exports (triple pattern) ─────────────────────────────────────────────────

const UsersAdminModule = {
  CAPABILITY_OPTIONS,
  shouldShowUsersCategory,
  buildUserRowView,
  buildUsersView,
  inviteFormHtml,
  grantsSectionHtml,
  userRowHtml,
  usersAdminHtml,
  listUsers,
  inviteUser,
  updateUser,
  reviewUser,
  listGrants,
  createGrant,
  revokeGrant,
  UsersAdminController,
};

if (typeof window !== "undefined") {
  window.UsersAdmin = UsersAdminModule;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = UsersAdminModule;
}

if (typeof exports !== "undefined") {
  exports.CAPABILITY_OPTIONS = CAPABILITY_OPTIONS;
  exports.shouldShowUsersCategory = shouldShowUsersCategory;
  exports.buildUserRowView = buildUserRowView;
  exports.buildUsersView = buildUsersView;
  exports.inviteFormHtml = inviteFormHtml;
  exports.grantsSectionHtml = grantsSectionHtml;
  exports.userRowHtml = userRowHtml;
  exports.usersAdminHtml = usersAdminHtml;
  exports.listUsers = listUsers;
  exports.inviteUser = inviteUser;
  exports.updateUser = updateUser;
  exports.reviewUser = reviewUser;
  exports.listGrants = listGrants;
  exports.createGrant = createGrant;
  exports.revokeGrant = revokeGrant;
  exports.UsersAdminController = UsersAdminController;
}
