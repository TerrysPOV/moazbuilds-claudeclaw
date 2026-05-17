#!/usr/bin/env python3
"""
Spike 0.4 deep probe — claude 2.1.126 Linux ARM64 (proot)

Stricter than v1:
  A. Plain stdin: measure downshift timing precisely (multiple runs)
  B. PTY: confirm /quit actually triggers clean exit (look for "See ya"/"Bye" farewell + exit 0)
  C. Show that --print mode doesn't need a TTY (sanity check)
"""

import os, sys, pty, time, signal, subprocess, tempfile, json, select, uuid
from pathlib import Path

CLAUDE = os.environ.get("SPIKE_CLAUDE", "claude")
HOME = os.environ.get("SPIKE_HOME", os.path.expanduser("~"))
PLAIN_RUNS = 3
PTY_RUNS = 3
HARD_TIMEOUT_S = 25


def make_cwd():
    return tempfile.mkdtemp(prefix="spike-0.4-cwd-")


def probe_plain_stdin_one():
    cwd = make_cwd()
    env = {**os.environ, "HOME": HOME, "PWD": cwd}
    start = time.time()
    out_bytes = bytearray()
    err_bytes = bytearray()

    proc = subprocess.Popen(
        [CLAUDE],
        cwd=cwd, env=env,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )

    # Wait up to HARD_TIMEOUT_S for exit
    end = time.time() + HARD_TIMEOUT_S
    while time.time() < end:
        if proc.poll() is not None:
            break
        r, _, _ = select.select([proc.stdout, proc.stderr], [], [], 0.2)
        for f in r:
            data = os.read(f.fileno(), 4096)
            if data:
                if f is proc.stdout: out_bytes.extend(data)
                else: err_bytes.extend(data)

    if proc.poll() is None:
        proc.terminate()
        try: proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill(); proc.wait(timeout=2)

    return {
        "cwd": cwd,
        "duration_s": round(time.time() - start, 3),
        "exit_code": proc.returncode,
        "stdout_bytes": len(out_bytes),
        "stderr_bytes": len(err_bytes),
        "stderr": err_bytes.decode("utf-8", errors="replace")[:500],
    }


def probe_pty_one():
    cwd = make_cwd()
    env = {**os.environ, "HOME": HOME, "PWD": cwd, "TERM": "xterm-256color"}
    session_id = str(uuid.uuid4())
    start = time.time()
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        for k, v in env.items(): os.environ[k] = v
        os.execvp(CLAUDE, [CLAUDE, "--session-id", session_id,
                           "--permission-mode", "plan", "--add-dir", cwd])
    out_bytes = bytearray()

    def read_for(seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.5)
            if r:
                try:
                    data = os.read(fd, 8192)
                    out_bytes.extend(data)
                except OSError: break
            try:
                pid_res, status = os.waitpid(pid, os.WNOHANG)
                if pid_res != 0: return (False, status)
            except ChildProcessError: return (False, 0)
        return (True, None)

    # Settle + Enter blasts to clear trust dialog
    time.sleep(3)
    for _ in range(4):
        try: os.write(fd, b"\r")
        except OSError: break
        time.sleep(1.5)

    read_for(8)

    # Now send /quit
    t_quit_sent = time.time() - start
    try: os.write(fd, b"/quit\r")
    except OSError: pass
    alive, status = read_for(8)

    # Reap if still alive
    if alive:
        try: os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError): pass
        time.sleep(1)
        try:
            pid_res, st = os.waitpid(pid, os.WNOHANG)
            if pid_res == 0:
                try: os.kill(pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError): pass
                try: _, status = os.waitpid(pid, 0)
                except ChildProcessError: pass
            else:
                status = st
        except ChildProcessError: pass

    try: os.close(fd)
    except: pass

    duration = time.time() - start
    exit_code = (status >> 8) if status and os.WIFEXITED(status) else (128 + os.WTERMSIG(status)) if status else -1
    out_text = out_bytes.decode("utf-8", errors="replace")
    farewell_match = None
    for fw in ["Goodbye!", "See ya!", "Bye!", "See you!", "Farewell!", "Cheers!"]:
        if fw in out_text:
            farewell_match = fw
            break

    return {
        "cwd": cwd, "session_id": session_id,
        "duration_s": round(duration, 3),
        "exit_code": exit_code,
        "stdout_bytes": len(out_bytes),
        "t_quit_sent_s": round(t_quit_sent, 3),
        "alive_after_quit_settle": alive,
        "farewell_in_output": farewell_match,
        "resume_hint_in_output": "claude --resume" in out_text,
    }


def probe_print_mode():
    """Sanity: --print mode works without TTY (this is the OK case)."""
    cwd = make_cwd()
    env = {**os.environ, "HOME": HOME, "PWD": cwd}
    start = time.time()
    result = subprocess.run(
        [CLAUDE, "-p", "Reply with exactly: PRINT_OK", "--session-id", str(uuid.uuid4())],
        cwd=cwd, env=env,
        stdin=subprocess.DEVNULL, capture_output=True, timeout=60,
    )
    return {
        "duration_s": round(time.time() - start, 3),
        "exit_code": result.returncode,
        "stdout": result.stdout.decode("utf-8", errors="replace").strip()[:200],
        "stderr": result.stderr.decode("utf-8", errors="replace").strip()[:200],
        "matches_expected": "PRINT_OK" in result.stdout.decode("utf-8", errors="replace"),
    }


if __name__ == "__main__":
    out = {"claude_version": "2.1.126", "platform": "Linux ARM64 proot"}

    print(f"=== A: plain stdin x{PLAIN_RUNS} ===")
    plain_runs = []
    for i in range(PLAIN_RUNS):
        r = probe_plain_stdin_one()
        plain_runs.append(r)
        print(f"  run {i+1}: exit={r['exit_code']} duration={r['duration_s']}s")
        print(f"    stderr: {r['stderr'][:200]}")
    out["plain_stdin"] = {
        "runs": plain_runs,
        "all_failed": all(r["exit_code"] != 0 for r in plain_runs),
        "duration_min_s": min(r["duration_s"] for r in plain_runs),
        "duration_max_s": max(r["duration_s"] for r in plain_runs),
        "all_have_print_error": all("--print" in r["stderr"] for r in plain_runs),
    }

    print(f"\n=== B: PTY x{PTY_RUNS} ===")
    pty_runs = []
    for i in range(PTY_RUNS):
        r = probe_pty_one()
        pty_runs.append(r)
        print(f"  run {i+1}: exit={r['exit_code']} t_quit_sent={r['t_quit_sent_s']}s "
              f"alive_after_quit={r['alive_after_quit_settle']} "
              f"farewell={r['farewell_in_output']!r} resume_hint={r['resume_hint_in_output']}")
    out["pty"] = {
        "runs": pty_runs,
        "any_clean_quit": any(not r["alive_after_quit_settle"] and r["exit_code"] == 0 for r in pty_runs),
        "any_farewell_captured": any(r["farewell_in_output"] for r in pty_runs),
        "any_resume_hint": any(r["resume_hint_in_output"] for r in pty_runs),
    }

    print(f"\n=== C: --print sanity ===")
    print_r = probe_print_mode()
    print(f"  exit={print_r['exit_code']} duration={print_r['duration_s']}s matches_expected={print_r['matches_expected']}")
    print(f"    stdout: {print_r['stdout']}")
    out["print_mode_sanity"] = print_r

    # Verdict
    out["verdict"] = {
        "plain_stdin_blocked": out["plain_stdin"]["all_failed"] and out["plain_stdin"]["all_have_print_error"],
        "pty_accepts_slash": out["pty"]["any_clean_quit"] or out["pty"]["any_farewell_captured"],
        "print_mode_works": print_r["matches_expected"],
        "conclusion": "plain stdin gated to --print; PTY required for interactive slash commands",
    }

    Path("/tmp/spikes-output/spike-0.4-deep-results.json").write_text(json.dumps(out, indent=2))
    print(f"\n=== VERDICT ===")
    print(json.dumps(out["verdict"], indent=2))
