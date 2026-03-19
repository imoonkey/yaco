"""PTY bridge: connect stdin/stdout to a tmux session via a PTY.
Usage: python3 pty_bridge.py <tmux-session-name> [cols] [rows]
Stdin/stdout carry raw terminal data. Resize via SIGWINCH or JSON on stdin."""
import pty, os, sys, select, struct, fcntl, termios, signal, json

session = sys.argv[1]
cols = int(sys.argv[2]) if len(sys.argv) > 2 else 80
rows = int(sys.argv[3]) if len(sys.argv) > 3 else 24

master_fd, slave_fd = pty.openpty()

# Set initial size
winsize = struct.pack('HHHH', rows, cols, 0, 0)
fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, winsize)

pid = os.fork()
if pid == 0:
    # Child: become session leader, attach slave as controlling terminal
    os.close(master_fd)
    os.setsid()
    fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
    os.dup2(slave_fd, 0)
    os.dup2(slave_fd, 1)
    os.dup2(slave_fd, 2)
    if slave_fd > 2:
        os.close(slave_fd)
    os.execvp('tmux', ['tmux', 'attach-session', '-t', session])

# Parent: relay between stdin/stdout and master_fd
os.close(slave_fd)

# Make stdin non-blocking
flags = fcntl.fcntl(0, fcntl.F_GETFL)
fcntl.fcntl(0, fcntl.F_SETFL, flags | os.O_NONBLOCK)

# Buffer for detecting resize JSON messages
buf = b''

def resize(c, r):
    ws = struct.pack('HHHH', r, c, 0, 0)
    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, ws)
    os.kill(pid, signal.SIGWINCH)

try:
    while True:
        rfds, _, _ = select.select([0, master_fd], [], [], 1.0)
        if master_fd in rfds:
            try:
                data = os.read(master_fd, 65536)
                if not data:
                    break
                os.write(1, data)
                sys.stdout.flush()
            except OSError:
                break
        if 0 in rfds:
            try:
                data = os.read(0, 65536)
                if not data:
                    break
                # Check for resize JSON: {"type":"resize","cols":N,"rows":N}
                # It will be on its own as a complete message from the server
                try:
                    msg = json.loads(data)
                    if msg.get('type') == 'resize':
                        resize(msg['cols'], msg['rows'])
                        continue
                except (json.JSONDecodeError, KeyError, TypeError):
                    pass
                os.write(master_fd, data)
            except OSError:
                break
except KeyboardInterrupt:
    pass
finally:
    os.close(master_fd)
    try:
        os.kill(pid, signal.SIGHUP)
        os.waitpid(pid, 0)
    except:
        pass
