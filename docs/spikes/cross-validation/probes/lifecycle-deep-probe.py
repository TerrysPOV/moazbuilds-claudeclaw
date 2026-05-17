#!/usr/bin/env python3
"""
Spike 0.5 deep probe — claude 2.1.126 Linux ARM64 (proot)

Extends the basic probe to validate:
  A. /compact with multi-turn history → check for compact_boundary subtype
  B. /quit run 5x → enumerate farewell variants
  C. /clear with rich history → confirm rotation + new file content
"""

import os, sys, pty, time, signal, tempfile, uuid, select, json, re
from pathlib import Path

CLAUDE = os.environ.get("SPIKE_CLAUDE", "claude")
HOME = os.environ.get("SPIKE_HOME", os.path.expanduser("~"))
PROJECTS_DIR = Path(HOME) / ".claude" / "projects"

SETTLE_AFTER_SPAWN_S = 15
SETTLE_AFTER_PROMPT_S = 60
SETTLE_AFTER_SLASH_S = 8
SETTLE_AFTER_EXIT_S = 3

OUT_BASE = Path("/tmp/spikes-output/fixtures/lifecycle-deep")
ENTER = b"\r"


def encoded_cwd(cwd):
    return cwd.replace("/", "-").replace(".", "-")


def find_jsonl_files(cwd):
    projects = PROJECTS_DIR / encoded_cwd(cwd)
    if not projects.exists():
        return []
    return sorted(projects.glob("*.jsonl"))


def snapshot_jsonls(cwd):
    out = {}
    for f in find_jsonl_files(cwd):
        try:
            out[f.name] = f.read_bytes()
        except:
            pass
    return out


class PtySession:
    def __init__(self, cwd, session_id, banner_buf):
        self.cwd = cwd
        self.session_id = session_id
        self.banner_buf = banner_buf
        self.pid = None
        self.fd = None
        self.start_ts = None

    def spawn(self):
        env = {**os.environ, "HOME": HOME, "PWD": self.cwd, "TERM": "xterm-256color"}
        self.start_ts = time.time()
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(self.cwd)
            for k, v in env.items():
                os.environ[k] = v
            args = [CLAUDE,
                    "--session-id", self.session_id,
                    "--permission-mode", "plan",
                    "--add-dir", self.cwd]
            os.execvp(CLAUDE, args)
        self.pid, self.fd = pid, fd

    def read_for(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.5)
            if r:
                try:
                    data = os.read(self.fd, 8192)
                    self.banner_buf.extend(data)
                except OSError:
                    break
            try:
                pid_res, _ = os.waitpid(self.pid, os.WNOHANG)
                if pid_res != 0:
                    return False
            except ChildProcessError:
                return False
        return True

    def write(self, text):
        try:
            os.write(self.fd, text.encode("utf-8") if isinstance(text, str) else text)
        except OSError:
            pass

    def reap(self):
        try:
            pid_res, status = os.waitpid(self.pid, os.WNOHANG)
            if pid_res == 0:
                os.kill(self.pid, signal.SIGTERM)
                time.sleep(1)
                pid_res, status = os.waitpid(self.pid, os.WNOHANG)
                if pid_res == 0:
                    os.kill(self.pid, signal.SIGKILL)
                    _, status = os.waitpid(self.pid, 0)
            try: os.close(self.fd)
            except: pass
            if os.WIFEXITED(status): return os.WEXITSTATUS(status)
            if os.WIFSIGNALED(status): return 128 + os.WTERMSIG(status)
            return -1
        except ChildProcessError:
            return -2


def fresh_session():
    cwd = tempfile.mkdtemp(prefix="spike-0.5-deep-")
    session_id = str(uuid.uuid4())
    banner = bytearray()
    sess = PtySession(cwd, session_id, banner)
    sess.spawn()
    time.sleep(3)
    for _ in range(4):
        sess.write(ENTER)
        time.sleep(1.5)
    sess.read_for(SETTLE_AFTER_SPAWN_S)
    return cwd, session_id, banner, sess


def send_turn(sess, prompt):
    sess.write(prompt)
    sess.write(ENTER)
    sess.read_for(SETTLE_AFTER_PROMPT_S)


def analyze(content_bytes):
    types, subtypes, cmds, farewells = {}, {}, [], []
    for line in content_bytes.decode("utf-8", errors="replace").splitlines():
        try:
            d = json.loads(line)
            t = d.get("type")
            types[t] = types.get(t, 0) + 1
            if t == "system":
                st = d.get("subtype")
                subtypes[st] = subtypes.get(st, 0) + 1
            msg = d.get("message", {})
            if isinstance(msg, dict):
                c = msg.get("content")
                if isinstance(c, str):
                    m = re.findall(r"<command-name>([^<]+)</command-name>", c)
                    cmds.extend(m)
                    m2 = re.search(r"<local-command-stdout>([^<]*)</local-command-stdout>", c)
                    if m2 and "/exit" in c:
                        farewells.append(m2.group(1))
        except:
            pass
    return {"types": types, "subtypes": subtypes, "cmds": cmds, "farewells": farewells}


def test_a_compact_multi_turn():
    """A: /compact with multi-turn history → check compact_boundary"""
    print("\n=== A: /compact with multi-turn history ===")
    cwd, sid, banner, sess = fresh_session()
    print(f"  cwd={cwd}, session_id={sid}")
    # 4 turns of meaningful content
    for i, prompt in enumerate([
        "Reply with exactly: TURN_1_OK",
        "Reply with exactly: TURN_2_OK",
        "Reply with exactly: TURN_3_OK",
        "Reply with exactly: TURN_4_OK",
    ]):
        send_turn(sess, prompt)
        print(f"  turn {i+1} sent")
    before = snapshot_jsonls(cwd)
    primary = f"{sid}.jsonl"
    before_lines = len(before.get(primary, b"").splitlines())
    print(f"  primary lines before /compact: {before_lines}")
    # /compact
    sess.write("/compact")
    sess.write(ENTER)
    sess.read_for(SETTLE_AFTER_SLASH_S * 4)  # compact may take longer
    after = snapshot_jsonls(cwd)
    after_lines = len(after.get(primary, b"").splitlines())
    print(f"  primary lines after /compact: {after_lines} (+{after_lines-before_lines})")
    # /quit
    sess.write("/quit"); sess.write(ENTER)
    sess.read_for(SETTLE_AFTER_EXIT_S)
    exit_code = sess.reap()
    final = snapshot_jsonls(cwd)
    analysis = analyze(final.get(primary, b""))
    new_files = set(final.keys()) - set(before.keys()) - {primary}
    print(f"  exit={exit_code}")
    print(f"  subtypes: {analysis['subtypes']}")
    print(f"  types: {analysis['types']}")
    print(f"  cmds: {analysis['cmds']}")
    print(f"  farewells: {analysis['farewells']}")
    print(f"  new files: {sorted(new_files)}")
    # Save
    out = OUT_BASE / "A-compact-multi-turn"
    out.mkdir(parents=True, exist_ok=True)
    (out / "before.jsonl").write_bytes(before.get(primary, b""))
    (out / "after.jsonl").write_bytes(final.get(primary, b""))
    (out / "banner.tail").write_bytes(bytes(banner[-8000:]))
    (out / "summary.json").write_text(json.dumps({
        "cwd": cwd, "session_id": sid, "exit_code": exit_code,
        "turns_sent": 4, "before_lines": before_lines, "after_lines": after_lines,
        "analysis": analysis, "new_files": sorted(new_files),
        "compact_boundary_present": "compact_boundary" in analysis["subtypes"],
    }, indent=2))
    return analysis


def test_b_quit_farewell_enumeration(n=5):
    """B: run /quit n times → enumerate farewell variants"""
    print(f"\n=== B: /quit x{n} farewell enumeration ===")
    farewells_seen = []
    for i in range(n):
        cwd, sid, banner, sess = fresh_session()
        sess.write("/quit"); sess.write(ENTER)
        sess.read_for(SETTLE_AFTER_SLASH_S)
        sess.reap()
        primary = snapshot_jsonls(cwd).get(f"{sid}.jsonl", b"")
        a = analyze(primary)
        if a["farewells"]:
            farewells_seen.append(a["farewells"][0])
            print(f"  run {i+1}: {a['farewells'][0]!r}")
        else:
            print(f"  run {i+1}: <no farewell captured>")
    out = OUT_BASE / "B-farewell-enumeration"
    out.mkdir(parents=True, exist_ok=True)
    (out / "summary.json").write_text(json.dumps({
        "runs": n,
        "farewells_seen": farewells_seen,
        "unique_variants": sorted(set(farewells_seen)),
    }, indent=2))
    return farewells_seen


def test_c_clear_with_history():
    """C: /clear with real history → confirm rotation + new file content"""
    print("\n=== C: /clear with multi-turn history ===")
    cwd, sid, banner, sess = fresh_session()
    print(f"  cwd={cwd}, session_id={sid}")
    for i, prompt in enumerate([
        "Reply with exactly: TURN_1_OK",
        "Reply with exactly: TURN_2_OK",
    ]):
        send_turn(sess, prompt)
        print(f"  turn {i+1} sent")
    before = snapshot_jsonls(cwd)
    primary = f"{sid}.jsonl"
    before_lines = len(before.get(primary, b"").splitlines())
    print(f"  primary lines before /clear: {before_lines}")
    sess.write("/clear"); sess.write(ENTER)
    sess.read_for(SETTLE_AFTER_SLASH_S * 2)
    after = snapshot_jsonls(cwd)
    primary_after_lines = len(after.get(primary, b"").splitlines())
    new_files_after = set(after.keys()) - set(before.keys()) - {primary}
    print(f"  primary lines after /clear: {primary_after_lines} (no change expected)")
    print(f"  new files after /clear: {sorted(new_files_after)}")
    sess.write("/quit"); sess.write(ENTER)
    sess.read_for(SETTLE_AFTER_EXIT_S)
    sess.reap()
    final = snapshot_jsonls(cwd)
    new_files_final = set(final.keys()) - set(before.keys()) - {primary}
    print(f"  new files after /quit: {sorted(new_files_final)}")
    out = OUT_BASE / "C-clear-with-history"
    out.mkdir(parents=True, exist_ok=True)
    (out / "before.jsonl").write_bytes(before.get(primary, b""))
    (out / "after-original.jsonl").write_bytes(final.get(primary, b""))
    for n in new_files_final:
        (out / f"post-{n}").write_bytes(final[n])
    (out / "banner.tail").write_bytes(bytes(banner[-8000:]))
    analysis_orig = analyze(final.get(primary, b""))
    analysis_new = {n: analyze(final[n]) for n in new_files_final}
    (out / "summary.json").write_text(json.dumps({
        "cwd": cwd, "session_id": sid,
        "before_lines": before_lines,
        "primary_lines_after_clear": primary_after_lines,
        "primary_lines_final": len(final.get(primary, b"").splitlines()),
        "new_files": sorted(new_files_final),
        "primary_unchanged_by_clear": (before_lines == primary_after_lines),
        "analysis_primary": analysis_orig,
        "analysis_new_files": analysis_new,
    }, indent=2))
    return analysis_orig, analysis_new


if __name__ == "__main__":
    OUT_BASE.mkdir(parents=True, exist_ok=True)
    a = test_a_compact_multi_turn()
    b = test_b_quit_farewell_enumeration(5)
    c = test_c_clear_with_history()
    print(f"\n=== DEEP TEST DONE ===")
    print(f"compact_boundary observed: {'compact_boundary' in a['subtypes']}")
    print(f"farewell variants: {sorted(set(b))}")
    print(f"clear rotation files: {sorted(c[1].keys())}")
    print(f"Fixtures: {OUT_BASE}")
