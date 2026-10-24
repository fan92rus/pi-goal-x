"""Actual Pi terminal bridge; commands arrive in actions.jsonl, bytes stay local."""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

config = json.load(open(sys.argv[1], encoding="utf8"))
pid, fd = pty.fork()
if pid == 0:
    os.chdir(config["cwd"])
    os.environ.update(config["env"])
    os.execvp(config["argv"][0], config["argv"])


def resize(rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.kill(pid, signal.SIGWINCH)


resize(32, 110)
offset = 0
began = time.monotonic()
with open(config["raw"], "wb", buffering=0) as raw:
    while time.monotonic() - began < 240:
        readable, _, _ = select.select([fd], [], [], 0.05)
        if readable:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            raw.write(chunk)
            # Real terminals answer the cursor-position/device queries that Pi
            # uses while initializing. Keep terminal rendering behavior real.
            if b"\x1b[6n" in chunk:
                os.write(fd, b"\x1b[1;1R")
        with open(config["actions"], encoding="utf8") as actions:
            actions.seek(offset)
            for line in actions:
                action = json.loads(line)
                if "text" in action:
                    os.write(fd, action["text"].encode())
                if "resize" in action:
                    resize(*action["resize"])
                if action.get("stop"):
                    os.kill(pid, signal.SIGTERM)
            offset = actions.tell()
        if os.waitpid(pid, os.WNOHANG)[0]:
            break
try:
    os.kill(pid, signal.SIGTERM)
except ProcessLookupError:
    pass
os.close(fd)
print(json.dumps({"captured": config["raw"], "elapsed": time.monotonic() - began}))
