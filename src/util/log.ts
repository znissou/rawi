/** What the core modules log through; the extension backs it with a VS Code output channel. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
