import { execSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export type SandboxBackendType = 'bubblewrap' | 'sandbox-exec' | 'docker' | 'none';

export function isDarwin(): boolean {
  return process.platform === 'darwin';
}

export function isLinux(): boolean {
  return process.platform === 'linux';
}

export function hasCommand(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function hasBubblewrap(): boolean {
  return isLinux() && hasCommand('bwrap');
}

export function hasSandboxExec(): boolean {
  return isDarwin() && hasCommand('sandbox-exec');
}

export function hasDocker(): boolean {
  if (!hasCommand('docker')) return false;
  try {
    execSync('docker info 2>/dev/null', { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export function dockerStatus(): 'running' | 'installed-not-running' | 'not-installed' {
  if (!hasCommand('docker')) return 'not-installed';
  try {
    execSync('docker info 2>/dev/null', { stdio: 'ignore', timeout: 3000 });
    return 'running';
  } catch {
    return 'installed-not-running';
  }
}

export function hasFuseOverlayfs(): boolean {
  return isLinux() && hasCommand('fuse-overlayfs');
}

export function hasOverlayfs(): boolean {
  if (!isLinux()) return false;
  try {
    const mounts = fs.readFileSync('/proc/filesystems', 'utf8');
    return mounts.includes('overlay');
  } catch {
    return false;
  }
}

export function hasRsync(): boolean {
  return hasCommand('rsync');
}

export function detectSandboxBackend(): SandboxBackendType {
  // Linux: bubblewrap gives a full mount namespace (best isolation)
  if (hasBubblewrap()) return 'bubblewrap';
  // macOS / cross-platform: Docker gives a complete filesystem namespace —
  // Claude sees ONLY /workspace and /root, nothing from the host leaks in.
  // Preferred over sandbox-exec which restricts syscalls but still exposes
  // the host filesystem (and has fragile PTY compatibility).
  if (hasDocker()) return 'docker';
  // macOS fallback: sandbox-exec (syscall restriction only, no fs isolation)
  if (hasSandboxExec()) return 'sandbox-exec';
  return 'none';
}

export function detectWorkspaceStrategy(): 'overlay' | 'fuse-overlay' | 'rsync' | 'copy' {
  if (hasOverlayfs()) return 'overlay';
  if (hasFuseOverlayfs()) return 'fuse-overlay';
  if (hasRsync()) return 'rsync';
  return 'copy';
}

export function tmpDir(prefix: string): string {
  return path.join(os.tmpdir(), `agentbox-${prefix}-${process.pid}`);
}

export function sandboxTmpBase(): string {
  return path.join(os.tmpdir(), `agentbox-${process.pid}`);
}

export function printPlatformInfo(): void {
  const backend = detectSandboxBackend();
  const wsStrategy = detectWorkspaceStrategy();
  const docker = dockerStatus();

  const descriptions: Record<SandboxBackendType, string> = {
    'bubblewrap':   'Linux mount namespace — full filesystem isolation, no root required',
    'docker':       'Container filesystem — Claude sees only /workspace and /root, nothing else',
    'sandbox-exec': 'macOS Seatbelt — syscall restriction only (host filesystem still visible)',
    'none':         'No isolation — UNSAFE, for development only',
  };

  const dockerLabel =
    docker === 'running'              ? '✓ running' :
    docker === 'installed-not-running' ? '✗ installed but not running (start Docker Desktop)' :
                                         '✗ not installed';

  console.log(`\nPlatform:           ${process.platform}`);
  console.log(`Sandbox backend:    ${backend}  (${descriptions[backend]})`);
  console.log(`Workspace strategy: ${wsStrategy}`);
  console.log(`\nAvailable backends:`);
  console.log(`  bubblewrap:   ${hasBubblewrap() ? '✓' : '✗ (Linux only)'}`);
  console.log(`  docker:       ${dockerLabel}`);
  console.log(`  sandbox-exec: ${hasSandboxExec() ? '✓' : '✗ (macOS only)'}`);

  if (backend === 'none') {
    console.warn('\nWARNING: No sandbox backend found.');
    console.warn('  macOS: Start Docker Desktop — https://www.docker.com/products/docker-desktop/');
    console.warn('  Linux: Install bubblewrap — sudo apt install bubblewrap');
  } else if (backend === 'sandbox-exec') {
    console.warn('\nNote: sandbox-exec does not provide filesystem isolation.');
    console.warn('Start Docker Desktop for full isolation: https://www.docker.com/products/docker-desktop/');
  }
}
