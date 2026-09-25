import { spawn } from 'node:child_process';

/** No shell interpolation: a server-provided URL is always one argument. */
export function openBrowser(url: string): boolean {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] as const
    : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] as const
    : ['xdg-open', [url]] as const;
  const child = spawn(command, [...args], { detached: true, stdio: 'ignore' });
  child.on('error', () => {}); child.unref();
  return true;
}
