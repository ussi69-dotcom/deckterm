// Turns the structured access-denial payloads from the backend (foundation
// gate + legacy allowed-roots resolution, see foundationGateJson and the
// no_matching_root denials in server.ts) into a human explanation and a
// "should we offer the Setup CTA" flag. Returns null for anything that is not
// an access denial so callers keep their own error formatting.
function describeAccessDenied(payload) {
  if (!payload || typeof payload !== "object") return null;

  switch (payload.reason) {
    case "no_matching_root":
    case "forbidden_root": {
      // Root denials carry a server-written detail (backend/forbidden-root.ts)
      // that names the rejected path, the governing setting and the fix. Only
      // trust `message` when `setting` marks it as that detail.
      const detail =
        typeof payload.message === "string" && payload.setting
          ? payload.message.trim()
          : "";
      if (detail) return { text: detail, showSetupCta: true };
      if (payload.reason === "forbidden_root") {
        const where = payload.path ? ` (${payload.path})` : "";
        return {
          text:
            `That directory${where} is outside the allowed roots. ` +
            "Use a directory inside an allowed root, or add it to ALLOWED_FILE_ROOTS and restart DeckTerm.",
          showSetupCta: true,
        };
      }
      const where = payload.path ? `: ${payload.path}` : "";
      return {
        text:
          `This path isn't under any registered project root${where}. ` +
          "Register the root in Setup or use a path inside an allowed root.",
        showSetupCta: true,
      };
    }
    case "bootstrap_required":
      return {
        text: "Server setup isn't finished — no admin has completed bootstrap yet. Open Setup to bootstrap the first admin.",
        showSetupCta: true,
      };
    case "missing_capability": {
      const resource =
        payload.resourceId && payload.resourceId !== "*"
          ? ` for ${payload.resourceType || "resource"} ${payload.resourceId}`
          : "";
      return {
        text: `You're missing the "${payload.capability || "required"}" capability grant${resource}. An admin can grant it in Setup.`,
        showSetupCta: true,
      };
    }
    default:
      return null;
  }
}

const AccessDenied = { describeAccessDenied };

if (typeof window !== "undefined") {
  window.AccessDenied = AccessDenied;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = AccessDenied;
}

if (typeof exports !== "undefined") {
  exports.describeAccessDenied = describeAccessDenied;
}
