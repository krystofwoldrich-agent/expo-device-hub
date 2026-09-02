import { describe, expect, test } from 'bun:test';

import {
  androidCaptureErrorMessage,
  parseAndroidCaptureSnapshot,
} from '../android-capture';

describe('Android capture source contract', () => {
  test('parses every supported source and the capture generation', () => {
    for (const mode of ['scrcpy', 'grpc-screenshot', 'grpc-stream'] as const) {
      expect(
        parseAndroidCaptureSnapshot({
          ok: true,
          serial: 'emulator-5554',
          mode,
          availableModes: ['scrcpy', 'grpc-screenshot', 'grpc-stream'],
          sessionGeneration: 7,
        }),
      ).toEqual({
        serial: 'emulator-5554',
        mode,
        availableModes: ['scrcpy', 'grpc-screenshot', 'grpc-stream'],
        generation: 7,
      });
    }
  });

  test('rejects malformed, unavailable, and unsafe-generation responses', () => {
    expect(
      parseAndroidCaptureSnapshot({
        ok: true,
        serial: 'emulator-5554',
        mode: 'grpc-stream',
        availableModes: ['scrcpy'],
        sessionGeneration: 1,
      }),
    ).toBeNull();
    expect(
      parseAndroidCaptureSnapshot({
        ok: true,
        serial: 'emulator-5554',
        mode: 'future-mode',
        availableModes: ['scrcpy', 'future-mode'],
        sessionGeneration: 1,
      }),
    ).toBeNull();
    expect(
      parseAndroidCaptureSnapshot({
        ok: true,
        serial: 'emulator-5554',
        mode: 'scrcpy',
        availableModes: ['scrcpy'],
        sessionGeneration: -1,
      }),
    ).toBeNull();
  });

  test('reads both legacy and structured API error messages', () => {
    expect(androidCaptureErrorMessage({ error: 'Emulator unavailable' }, 'fallback')).toBe(
      'Emulator unavailable',
    );
    expect(
      androidCaptureErrorMessage(
        { error: { code: 'service_unavailable', message: 'Capture did not start' } },
        'fallback',
      ),
    ).toBe('Capture did not start');
    expect(androidCaptureErrorMessage(null, 'fallback')).toBe('fallback');
  });
});
