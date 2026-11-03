/** Removes the technical prefix Electron adds to errors from the main process. */
export function errorMessage(error: unknown): string {
  return String((error as Error).message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
