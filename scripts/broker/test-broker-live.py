import os, pty, select, sys, time

DUID = os.popen("id -u dtbroker1").read().strip()
DGID = os.popen("id -g dtbroker1").read().strip()
BR = "/usr/local/lib/deckterm/deckterm-broker"
session = "term_ptytest01"
argv = ["sudo", "-n", BR, "spawn", "--session", session,
        "--username", "dtbroker1", "--uid", DUID, "--gid", DGID,
        "--cwd", "/home/dtbroker1", "--profile", "pty", "--cols", "80", "--rows", "24"]

pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
    os._exit(127)

# Parent: drive the shell.
out = []
def drain(timeout):
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            out.append(data.decode("utf-8", "replace"))

drain(1.5)
os.write(fd, b"id -a\n")
drain(1.0)
os.write(fd, b"tty; echo CTTY_OK\n")
drain(1.0)
os.write(fd, b"exit\n")
drain(1.0)
try:
    os.waitpid(pid, 0)
except OSError:
    pass
text = "".join(out)
sys.stdout.write("----- shell output -----\n")
sys.stdout.write(text)
sys.stdout.write("\n----- assertions -----\n")
# Must run as dtbroker1, and MUST NOT carry gid 0(root) or 1001(deploy).
ok = True
if "uid=%s(dtbroker1)" % DUID not in text:
    print("FAIL: shell not running as dtbroker1"); ok = False
else:
    print("PASS: shell runs as dtbroker1")
if "groups=" in text:
    grp_line = [l for l in text.splitlines() if "uid=%s(dtbroker1)" % DUID in l]
    joined = " ".join(grp_line)
    if "(root)" in joined or "1001(deploy)" in joined or "(deploy)" in joined:
        print("FAIL: root/deploy supplementary group LEAKED: %s" % joined); ok = False
    else:
        print("PASS: no root/deploy supplementary group leak")
print("RESULT:", "PASS" if ok else "FAIL")
