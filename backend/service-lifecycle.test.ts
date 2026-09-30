import { describe, expect, test } from "bun:test";
import {
  detectServiceLifecycle,
  evaluateHomeRootCoverage,
  evaluateNeedrestartConfig,
  evaluateTmuxPersistence,
  parseEnvironmentFiles,
  parseSystemdUnitFromCgroup,
  pickDefaultTerminalCwd,
  resolveDoctorEnvFile,
} from "./service-lifecycle";

describe("parseSystemdUnitFromCgroup", () => {
  test("user-manager service", () => {
    expect(
      parseSystemdUnitFromCgroup(
        "0::/user.slice/user-1001.slice/user@1001.service/app.slice/deckterm-dev.service\n",
      ),
    ).toEqual({ unit: "deckterm-dev.service", scope: "user" });
  });

  test("system service", () => {
    expect(parseSystemdUnitFromCgroup("0::/system.slice/deckterm.service")).toEqual(
      { unit: "deckterm.service", scope: "system" },
    );
  });

  test("not inside a service → null", () => {
    expect(
      parseSystemdUnitFromCgroup("0::/user.slice/user-1001.slice/session-3.scope"),
    ).toBeNull();
    expect(parseSystemdUnitFromCgroup("")).toBeNull();
  });

  test("the user manager itself is not a service we can restart-check", () => {
    expect(
      parseSystemdUnitFromCgroup("0::/user.slice/user-1001.slice/user@1001.service"),
    ).toBeNull();
  });
});

describe("parseEnvironmentFiles", () => {
  test("strips the ignore_errors annotation and blank lines", () => {
    expect(
      parseEnvironmentFiles("/srv/prod.env (ignore_errors=yes)\n/etc/x.env (ignore_errors=no)\n\n"),
    ).toEqual(["/srv/prod.env", "/etc/x.env"]);
    expect(parseEnvironmentFiles("")).toEqual([]);
  });
});

describe("evaluateTmuxPersistence", () => {
  test("control-group under the tmux backend warns", () => {
    const check = evaluateTmuxPersistence({
      tmuxBackend: true,
      unit: "deckterm.service",
      killMode: "control-group",
    });
    expect(check?.status).toBe("warning");
    expect(check?.message).toContain("KillMode=control-group");
    expect(check?.message).toContain("KillMode=process");
  });

  test("process is ok", () => {
    expect(
      evaluateTmuxPersistence({
        tmuxBackend: true,
        unit: "deckterm.service",
        killMode: "process",
      })?.status,
    ).toBe("ok");
  });

  test("raw backend or no systemd unit → no check", () => {
    expect(
      evaluateTmuxPersistence({ tmuxBackend: false, unit: "x.service", killMode: "control-group" }),
    ).toBeNull();
    expect(evaluateTmuxPersistence({ tmuxBackend: true, unit: null, killMode: null })).toBeNull();
  });
});

describe("evaluateNeedrestartConfig", () => {
  test("automatic mode without an override warns", () => {
    const check = evaluateNeedrestartConfig({
      confText: "$nrconf{restart} = 'a';\n",
      unit: "deckterm.service",
    });
    expect(check?.status).toBe("warning");
    expect(check?.message).toContain("deploy/needrestart/deckterm.conf");
  });

  test("automatic mode with a matching override is ok", () => {
    expect(
      evaluateNeedrestartConfig({
        confText: "$nrconf{restart} = 'a';\n$nrconf{override_rc}{qr(^deckterm(-dev|-tmux)?\\.service$)} = 0;\n",
        unit: "deckterm.service",
      })?.status,
    ).toBe("ok");
  });

  test("list/interactive mode (or commented default) is ok", () => {
    expect(
      evaluateNeedrestartConfig({ confText: "#$nrconf{restart} = 'i';\n", unit: "deckterm.service" })
        ?.status,
    ).toBe("ok");
    expect(
      evaluateNeedrestartConfig({ confText: "$nrconf{restart} = 'l';", unit: "deckterm.service" })
        ?.status,
    ).toBe("ok");
  });

  test("no config readable → no check", () => {
    expect(evaluateNeedrestartConfig({ confText: null, unit: "deckterm.service" })).toBeNull();
  });
});

describe("evaluateHomeRootCoverage", () => {
  test("home outside every allowed root is informational and names the fallback", () => {
    const check = evaluateHomeRootCoverage({ home: "/home/deploy", allowedRoots: ["/srv/work"] });
    expect(check?.status).toBe("ok");
    expect(check?.message).toContain("/home/deploy");
    expect(check?.message).toContain("ALLOWED_FILE_ROOTS");
    expect(check?.message).toContain("start in /srv/work");
  });

  test("home equal to or under an allowed root is ok", () => {
    expect(
      evaluateHomeRootCoverage({ home: "/home/deploy", allowedRoots: ["/home/deploy"] })?.message,
    ).toContain("is inside");
    expect(
      evaluateHomeRootCoverage({ home: "/home/deploy/", allowedRoots: ["/home"] })?.message,
    ).toContain("is inside");
  });

  test("a prefix that is not a path boundary does not count", () => {
    expect(
      evaluateHomeRootCoverage({ home: "/home/deploy2", allowedRoots: ["/home/deploy"] })?.message,
    ).toContain("is outside");
  });

  test("no home or no roots → no check", () => {
    expect(evaluateHomeRootCoverage({ home: "", allowedRoots: ["/x"] })).toBeNull();
    expect(evaluateHomeRootCoverage({ home: "/home/x", allowedRoots: [] })).toBeNull();
  });
});

describe("pickDefaultTerminalCwd", () => {
  test("home when it is an allowed root", () => {
    expect(pickDefaultTerminalCwd({ home: "/home/deploy", allowedRoots: ["/srv", "/home/deploy"] })).toBe(
      "/home/deploy",
    );
    expect(pickDefaultTerminalCwd({ home: "/home/deploy/", allowedRoots: ["/home"] })).toBe(
      "/home/deploy",
    );
  });

  test("first allowed root when home is outside", () => {
    expect(pickDefaultTerminalCwd({ home: "/home/deploy", allowedRoots: ["/srv/work/", "/opt"] })).toBe(
      "/srv/work",
    );
  });

  test("home when there are no roots at all", () => {
    expect(pickDefaultTerminalCwd({ home: "/home/deploy", allowedRoots: [] })).toBe("/home/deploy");
    expect(pickDefaultTerminalCwd({ home: "", allowedRoots: [] })).toBe("/");
  });
});

describe("detectServiceLifecycle", () => {
  test("asks systemctl (with --user for user units) for KillMode and EnvironmentFiles", async () => {
    const calls: string[][] = [];
    const result = await detectServiceLifecycle({
      readCgroup: async () =>
        "0::/user.slice/user-1001.slice/user@1001.service/app.slice/deckterm-dev.service",
      runSystemctl: async (args) => {
        calls.push(args);
        return args.includes("KillMode")
          ? "process\n"
          : "/home/deploy/deckterm/.env (ignore_errors=no)\n";
      },
    });
    expect(result).toEqual({
      unit: "deckterm-dev.service",
      scope: "user",
      killMode: "process",
      environmentFiles: ["/home/deploy/deckterm/.env"],
    });
    expect(calls).toEqual([
      ["--user", "show", "-p", "KillMode", "--value", "deckterm-dev.service"],
      ["--user", "show", "-p", "EnvironmentFiles", "--value", "deckterm-dev.service"],
    ]);
  });

  test("system unit → no --user flag", async () => {
    const calls: string[][] = [];
    await detectServiceLifecycle({
      readCgroup: async () => "0::/system.slice/deckterm.service",
      runSystemctl: async (args) => {
        calls.push(args);
        return "control-group\n";
      },
    });
    expect(calls[0]).toEqual(["show", "-p", "KillMode", "--value", "deckterm.service"]);
  });

  test("outside systemd → null; systemctl failure → nulls, not a throw", async () => {
    expect(
      await detectServiceLifecycle({
        readCgroup: async () => {
          throw new Error("no cgroup");
        },
        runSystemctl: async () => "",
      }),
    ).toBeNull();
    expect(
      await detectServiceLifecycle({
        readCgroup: async () => "0::/system.slice/deckterm.service",
        runSystemctl: async () => {
          throw new Error("systemctl missing");
        },
      }),
    ).toEqual({ unit: "deckterm.service", scope: "system", killMode: null, environmentFiles: [] });
  });
});

describe("resolveDoctorEnvFile", () => {
  test("explicit override wins, then the unit's EnvironmentFile, then .env in cwd", () => {
    expect(
      resolveDoctorEnvFile({
        cwd: "/app",
        explicit: "/custom.env",
        lifecycle: { environmentFiles: ["/srv/prod.env"] },
      }),
    ).toBe("/custom.env");
    expect(
      resolveDoctorEnvFile({
        cwd: "/app",
        explicit: undefined,
        lifecycle: { environmentFiles: ["/srv/prod.env"] },
      }),
    ).toBe("/srv/prod.env");
    expect(resolveDoctorEnvFile({ cwd: "/app", explicit: undefined, lifecycle: null })).toBe(
      "/app/.env",
    );
    expect(resolveDoctorEnvFile({ cwd: "/app", explicit: "rel.env", lifecycle: null })).toBe(
      "/app/rel.env",
    );
  });
});
