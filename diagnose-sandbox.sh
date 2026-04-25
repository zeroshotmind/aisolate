#!/bin/bash
# Run this on your Mac to diagnose what sandbox-exec is blocking.
# Usage: bash diagnose-sandbox.sh

set -e

CLAUDE=$(which claude 2>/dev/null || echo "$HOME/.local/bin/claude")
if [ ! -f "$CLAUDE" ]; then
  echo "ERROR: claude not found. Set CLAUDE=/path/to/claude"
  exit 1
fi

WORKSPACE=$(mktemp -d)
FAKEHOME=$(mktemp -d)
PROFILE=$(mktemp /tmp/agentbox-diag.XXXXXX.sb)

# Write a maximally permissive profile (read everywhere, write only sandbox)
cat > "$PROFILE" << 'SB'
(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow file-read* (subpath "/"))
(allow file-write*
  (subpath "/private/tmp")
  (subpath "/private/var/folders")
  (literal "/dev/null")
  (literal "/dev/tty")
  (literal "/dev/ptmx")
  (regex #"^/dev/ttys[0-9]+$")
)
(allow file-ioctl
  (literal "/dev/tty")
  (literal "/dev/ptmx")
  (regex #"^/dev/ttys[0-9]+$")
)
(allow mach-lookup)
(allow mach-register)
(allow sysctl-read)
(allow network-outbound)
(allow network-inbound (local ip))
(allow network-inbound (local tcp))
(allow ipc-posix-shm)
(allow ipc-posix-sem)
SB

echo "=== Diagnostic 1: sandbox-exec with permissive profile (no PTY) ==="
echo "Command: /usr/bin/sandbox-exec -f $PROFILE $CLAUDE --version"
HOME="$FAKEHOME" /usr/bin/sandbox-exec -f "$PROFILE" "$CLAUDE" --version 2>&1
echo "Exit: $?"

echo ""
echo "=== Diagnostic 2: sandbox-exec via script PTY ==="
echo "Command: /usr/bin/script -q -F /dev/null /usr/bin/sandbox-exec -f $PROFILE $CLAUDE --version"
HOME="$FAKEHOME" /usr/bin/script -q -F /dev/null /usr/bin/sandbox-exec -f "$PROFILE" "$CLAUDE" --version 2>&1
echo "Exit: $?"

echo ""
echo "=== Diagnostic 3: sandbox-exec --report to see denials ==="
echo "Command: /usr/bin/sandbox-exec -D -f $PROFILE $CLAUDE --version"
HOME="$FAKEHOME" /usr/bin/sandbox-exec -D -f "$PROFILE" "$CLAUDE" --version 2>&1
echo "Exit: $?"

echo ""
echo "=== Diagnostic 4: plain claude --version (no sandbox) ==="
HOME="$FAKEHOME" "$CLAUDE" --version 2>&1
echo "Exit: $?"

echo ""
echo "Profile used: $PROFILE"
echo "Workspace:    $WORKSPACE"
echo "FakeHome:     $FAKEHOME"
echo ""
echo "To inspect the profile: cat $PROFILE"
echo "Cleaning up..."
rm -rf "$WORKSPACE" "$FAKEHOME" "$PROFILE"
