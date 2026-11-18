"""An exclusive lock on an open file, on macOS, Linux and Windows.

POSIX uses flock; Windows has no fcntl, so it locks the file's first byte with msvcrt instead. The lock is
released when the file is closed, as with flock.
"""
import os


def lock_exclusive(handle) -> None:
    if os.name == 'nt':
        import msvcrt
        handle.seek(0)
        # LK_LOCK retries for about ten seconds before raising; loop for the same blocking behaviour as flock.
        while True:
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
                return
            except OSError:
                continue
    import fcntl
    fcntl.flock(handle, fcntl.LOCK_EX)
