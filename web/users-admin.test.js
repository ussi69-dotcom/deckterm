import { test, expect } from "bun:test";
import {
  shouldShowUsersCategory,
  buildUsersView,
  usersAdminHtml,
  CAPABILITY_OPTIONS,
} from "./users-admin.js";

// ── shouldShowUsersCategory ──────────────────────────────────────────────────

test("shouldShowUsersCategory: null user -> false", () => {
  expect(shouldShowUsersCategory({ auth: { user: null } })).toBe(false);
  expect(shouldShowUsersCategory({})).toBe(false);
  expect(shouldShowUsersCategory(null)).toBe(false);
  expect(shouldShowUsersCategory(undefined)).toBe(false);
});

test("shouldShowUsersCategory: member role -> false", () => {
  expect(
    shouldShowUsersCategory({
      auth: { user: { id: "u1", role: "member", disabled: false } },
    }),
  ).toBe(false);
});

test("shouldShowUsersCategory: disabled admin -> false", () => {
  expect(
    shouldShowUsersCategory({
      auth: { user: { id: "u1", role: "admin", disabled: true } },
    }),
  ).toBe(false);
});

test("shouldShowUsersCategory: enabled admin -> true", () => {
  expect(
    shouldShowUsersCategory({
      auth: { user: { id: "u1", role: "admin", disabled: false } },
    }),
  ).toBe(true);
});

test("shouldShowUsersCategory: owner -> true", () => {
  expect(
    shouldShowUsersCategory({
      auth: { user: { id: "u1", role: "owner", disabled: false } },
    }),
  ).toBe(true);
});

// ── buildUsersView / usersAdminHtml — OWNER ──────────────────────────────────

const owner = { id: "owner-1", role: "owner", disabled: false };
const admin = { id: "admin-1", role: "admin", disabled: false };

const ownerRow = {
  id: "owner-1",
  email: "owner@example.com",
  displayName: "Owner Person",
  role: "owner",
  disabled: false,
  multiuserReviewedAt: null,
  liveTerminalCount: 2,
};

const unreviewedAdminRow = {
  id: "admin-2",
  email: "admin2@example.com",
  displayName: "Admin Two",
  role: "admin",
  disabled: false,
  multiuserReviewedAt: null,
  liveTerminalCount: 0,
};

const reviewedAdminRow = {
  id: "admin-3",
  email: "admin3@example.com",
  displayName: "Admin Three",
  role: "admin",
  disabled: false,
  multiuserReviewedAt: "2026-07-03T00:00:00.000Z",
  liveTerminalCount: 1,
};

const memberRow = {
  id: "member-1",
  email: "member@example.com",
  displayName: "Member One",
  role: "member",
  disabled: false,
  multiuserReviewedAt: null,
  liveTerminalCount: 3,
};

test("buildUsersView (owner actor): owner row is unmanageable, admin rows managed, invite offers admin role", () => {
  const model = buildUsersView({
    currentUser: owner,
    users: [ownerRow, unreviewedAdminRow, memberRow],
    grantsByUser: {},
  });
  expect(model.isOwner).toBe(true);
  expect(model.inviteRoleOptions).toEqual(["member", "admin"]);

  const ownerRowView = model.rows.find((r) => r.id === "owner-1");
  expect(ownerRowView.showRoleSelect).toBe(false);
  expect(ownerRowView.showDisableButton).toBe(false);
  expect(ownerRowView.showReviewActions).toBe(false);
  expect(ownerRowView.canManageGrants).toBe(false);

  const adminRowView = model.rows.find((r) => r.id === "admin-2");
  expect(adminRowView.showRoleSelect).toBe(true);
  expect(adminRowView.showDisableButton).toBe(true);
  expect(adminRowView.needsReview).toBe(true);
  expect(adminRowView.showReviewActions).toBe(true);
  expect(adminRowView.canManageGrants).toBe(true);

  const memberRowView = model.rows.find((r) => r.id === "member-1");
  expect(memberRowView.showRoleSelect).toBe(true);
  expect(memberRowView.showDisableButton).toBe(true);
  expect(memberRowView.showReviewActions).toBe(false);
});

test("rendered HTML for an OWNER actor: owner row has no role select / disable button; unreviewed admin shows review actions; invite form offers the admin role option", () => {
  const model = buildUsersView({
    currentUser: owner,
    users: [ownerRow, unreviewedAdminRow, reviewedAdminRow, memberRow],
    grantsByUser: {},
  });
  const html = usersAdminHtml(model);

  // Invite form: admin option present for the owner actor.
  expect(html).toContain('data-users-admin-form="invite"');
  expect(html).toContain('<option value="admin">admin</option>');

  // Owner row: no role select, no disable button, no review actions for that
  // row — only the static role badge.
  const ownerRowHtml = html.slice(
    html.indexOf('data-user-row="owner-1"'),
    html.indexOf('data-user-row="admin-2"'),
  );
  expect(ownerRowHtml).not.toContain('data-user-action="role"');
  expect(ownerRowHtml).not.toContain('data-user-action="toggle-disabled"');
  expect(ownerRowHtml).not.toContain("data-user-review-action");
  expect(ownerRowHtml).toContain("users-admin-role-badge");

  // Unreviewed admin row: review actions + needs-review marker present.
  const unreviewedRowHtml = html.slice(
    html.indexOf('data-user-row="admin-2"'),
    html.indexOf('data-user-row="admin-3"'),
  );
  expect(unreviewedRowHtml).toContain('data-testid="needs-review"');
  expect(unreviewedRowHtml).toContain('data-user-review-action="keep_admin"');
  expect(unreviewedRowHtml).toContain('data-user-review-action="make_member"');
  expect(unreviewedRowHtml).toContain('data-user-review-action="disable"');
  expect(unreviewedRowHtml).toContain('data-user-action="role"');
  expect(unreviewedRowHtml).toContain('data-user-action="toggle-disabled"');

  // Reviewed admin row: no needs-review marker, no review actions, but role
  // select + disable button remain (owner actor manages admin rows).
  const reviewedRowHtml = html.slice(
    html.indexOf('data-user-row="admin-3"'),
    html.indexOf('data-user-row="member-1"'),
  );
  expect(reviewedRowHtml).not.toContain('data-testid="needs-review"');
  expect(reviewedRowHtml).not.toContain("data-user-review-action");
  expect(reviewedRowHtml).toContain('data-user-action="role"');
});

// ── buildUsersView / usersAdminHtml — non-owner ADMIN ────────────────────────

test("buildUsersView (non-owner admin actor): no review anywhere, admin rows unmanageable, member rows still actionable", () => {
  const model = buildUsersView({
    currentUser: admin,
    users: [ownerRow, unreviewedAdminRow, memberRow],
    grantsByUser: {},
  });
  expect(model.isOwner).toBe(false);
  expect(model.inviteRoleOptions).toEqual(["member"]);

  const ownerRowView = model.rows.find((r) => r.id === "owner-1");
  expect(ownerRowView.showRoleSelect).toBe(false);
  expect(ownerRowView.showDisableButton).toBe(false);

  const otherAdminRowView = model.rows.find((r) => r.id === "admin-2");
  expect(otherAdminRowView.showRoleSelect).toBe(false);
  expect(otherAdminRowView.showDisableButton).toBe(false);
  expect(otherAdminRowView.showReviewActions).toBe(false);
  expect(otherAdminRowView.canManageGrants).toBe(false);

  const memberRowView = model.rows.find((r) => r.id === "member-1");
  expect(memberRowView.showRoleSelect).toBe(true);
  expect(memberRowView.showDisableButton).toBe(true);
  expect(memberRowView.canManageGrants).toBe(true);
});

test("rendered HTML for a non-owner ADMIN actor: no review buttons anywhere, no admin option in invite role select, no disable button on admin rows, member rows actionable", () => {
  const model = buildUsersView({
    currentUser: admin,
    users: [ownerRow, unreviewedAdminRow, memberRow],
    grantsByUser: {},
  });
  const html = usersAdminHtml(model);

  // Invite form: no admin option offered to a non-owner admin.
  expect(html).not.toContain('<option value="admin">admin</option>');
  expect(html).toContain('<option value="member">member</option>');

  // No review affordance anywhere in the whole panel.
  expect(html).not.toContain("data-user-review-action");
  expect(html).not.toContain("users-admin-review-actions");

  // Admin row (not the acting user, another admin): no disable button, no
  // role select.
  const adminRowHtml = html.slice(
    html.indexOf('data-user-row="admin-2"'),
    html.indexOf('data-user-row="member-1"'),
  );
  expect(adminRowHtml).not.toContain('data-user-action="toggle-disabled"');
  expect(adminRowHtml).not.toContain('data-user-action="role"');

  // Member row: still actionable (role select + disable button present).
  const memberRowHtml = html.slice(html.indexOf('data-user-row="member-1"'));
  expect(memberRowHtml).toContain('data-user-action="role"');
  expect(memberRowHtml).toContain('data-user-action="toggle-disabled"');
});

// ── Grants sub-list ───────────────────────────────────────────────────────────

test("grants sub-list renders rows and the add form offers no wildcard option", () => {
  const grantsByUser = {
    "member-1": [
      {
        id: "g1",
        capability: "terminal.create",
        resourceType: "root",
        resourceId: "home",
      },
      {
        id: "g2",
        capability: "root.use",
        resourceType: "root",
        resourceId: "projects",
      },
    ],
  };
  const model = buildUsersView({
    currentUser: owner,
    users: [memberRow],
    grantsByUser,
  });
  const html = usersAdminHtml(model);

  expect(html).toContain('data-grant-id="g1"');
  expect(html).toContain('data-grant-id="g2"');
  expect(html).toContain('data-grant-action="revoke"');
  expect(html).toContain("terminal.create");
  expect(html).toContain("root.use");

  // The add-grant form exists and enumerates the five real capabilities —
  // never a wildcard value or label.
  expect(html).toContain('data-users-admin-form="grant-add"');
  for (const cap of CAPABILITY_OPTIONS) {
    expect(html).toContain(`<option value="${cap}">${cap}</option>`);
  }
  expect(html).not.toContain('value="*"');
  expect(html).not.toContain(">*<");
});

test("grants sub-list hides the add form (and revoke buttons) when the actor cannot manage the target", () => {
  // Non-owner admin viewing another admin's grants: canManageGrants is false.
  const grantsByUser = {
    "admin-2": [
      {
        id: "g3",
        capability: "terminal.attach",
        resourceType: "root",
        resourceId: "home",
      },
    ],
  };
  const model = buildUsersView({
    currentUser: admin,
    users: [unreviewedAdminRow],
    grantsByUser,
  });
  const html = usersAdminHtml(model);

  // The grant is still listed (read-only)...
  expect(html).toContain('data-grant-id="g3"');
  // ...but no revoke button or add form is offered.
  expect(html).not.toContain('data-grant-action="revoke"');
  expect(html).not.toContain('data-users-admin-form="grant-add"');
});

test("buildUsersView tolerates a missing/empty model", () => {
  const model = buildUsersView({});
  expect(model.rows).toEqual([]);
  expect(model.isOwner).toBe(false);
  expect(model.inviteRoleOptions).toEqual(["member"]);
  expect(model.canInvite).toBe(false);

  const html = usersAdminHtml(model);
  expect(html).toContain("users-admin-table");
  expect(html).toContain("No users");
  // No currentUser -> no invite form rendered.
  expect(html).not.toContain('data-users-admin-form="invite"');
});
