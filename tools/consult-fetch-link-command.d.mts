/** @implements CC-CONSULT-INV-07; declaration of the existing bounded command policy. */
export const FETCH_LINK_SCRIPT_ENV: 'CONCORDIA_CONSULT_FETCH_LINK_SCRIPT';
export function commandText(command: unknown): string | null;
export function isAllowedFetchLinkCommand(command: unknown, scriptPath: unknown): boolean;
