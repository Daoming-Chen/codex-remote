"""Forward complete Codex event lines, preserving the sequence on reconnect."""
import base64
import ctypes
import os
import select
import sys
import time
from pathlib import Path


def directory_watch(directory):
    try:
        libc = ctypes.CDLL(None)
        fd = libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        if fd >= 0:
            # Modification, move into the directory, or file creation.
            if libc.inotify_add_watch(fd, os.fsencode(directory), 0x002 | 0x080 | 0x100) >= 0:
                return fd
            os.close(fd)
    except (AttributeError, OSError):
        pass
    return None


def follow(directory, start):
    path = directory / "events"
    done = directory / "rc"
    deadline = time.monotonic() + 300
    fd = directory_watch(directory)

    def wait():
        remaining = max(0, deadline - time.monotonic())
        if fd is None:
            time.sleep(min(0.08, remaining))
        elif select.select([fd], [], [], min(5, remaining))[0]:
            os.read(fd, 65536)

    try:
        while not path.exists():
            if done.exists() or time.monotonic() >= deadline:
                return
            wait()
        with path.open("rb") as events:
            opened = time.time_ns() // 1000000
            sequence = longest_write = 0
            while time.monotonic() < deadline:
                # Once rc exists, the writer has closed events. Check before EOF.
                finished = done.exists()
                position = events.tell()
                line = events.readline()
                if not line.endswith(b"\n"):
                    if finished:
                        return
                    events.seek(position)
                    wait()
                    continue
                sequence += 1
                if sequence > start:
                    writing = time.monotonic_ns()
                    print("CX", sequence, base64.b64encode(line).decode(),
                          time.time_ns() // 1000000, opened, longest_write, flush=True)
                    longest_write = max(longest_write, (time.monotonic_ns() - writing) // 1000000)
    finally:
        if fd is not None:
            os.close(fd)


if __name__ == "__main__":
    follow(Path(sys.argv[1]), int(sys.argv[2]))
