import { type AndroidCaptureSource } from './types';

export const ANDROID_CAPTURE_SOURCES = [
  'scrcpy',
  'grpc-screenshot',
  'grpc-stream',
] as const satisfies readonly AndroidCaptureSource[];

export type AndroidCaptureSnapshot = {
  serial: string;
  mode: AndroidCaptureSource;
  availableModes: readonly AndroidCaptureSource[];
  generation: number;
};

export function isAndroidCaptureSource(value: unknown): value is AndroidCaptureSource {
  return ANDROID_CAPTURE_SOURCES.some((source) => source === value);
}

/** Validate serve-emu's device-scoped `/api/stream-mode` response. */
export function parseAndroidCaptureSnapshot(value: unknown): AndroidCaptureSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.ok !== true ||
    typeof candidate.serial !== 'string' ||
    !isAndroidCaptureSource(candidate.mode) ||
    !Array.isArray(candidate.availableModes) ||
    !candidate.availableModes.every(isAndroidCaptureSource) ||
    !candidate.availableModes.includes(candidate.mode) ||
    !Number.isSafeInteger(candidate.sessionGeneration) ||
    Number(candidate.sessionGeneration) < 0
  ) {
    return null;
  }

  return {
    serial: candidate.serial,
    mode: candidate.mode,
    availableModes: candidate.availableModes,
    generation: Number(candidate.sessionGeneration),
  };
}

export function androidCaptureErrorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.error === 'string' && candidate.error) return candidate.error;
  if (
    candidate.error &&
    typeof candidate.error === 'object' &&
    !Array.isArray(candidate.error) &&
    typeof (candidate.error as Record<string, unknown>).message === 'string'
  ) {
    return (candidate.error as { message: string }).message;
  }
  return fallback;
}
