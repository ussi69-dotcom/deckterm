// Turns the structured access-denial payloads from the backend (foundation
// gate + legacy allowed-roots resolution, see foundationGateJson and the
// no_matching_root denials in server.ts) into a human explanation and a
// "should we offer the Setup CTA" flag. Returns null for anything that is not
// an access denial so callers keep their own error formatting.
function describeAccessDenied(payload) {
  if (!payload || typeof payload !== "object") return null;

  switch (payload.reason) {
    case "no_matching_root": {
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
