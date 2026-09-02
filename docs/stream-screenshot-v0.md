# PROTOTYPE/V0: Expo Device Hub with Emulator `streamScreenshot`

This is deliberately experimental code on
`codex/stream-resolution-control-experimental`. It answers one question:

> Can Expo Device Hub keep its existing browser H.264 video path while the
> Android server acquires frames from one Emulator Controller
> `streamScreenshot` RPC?

## Run

Boot an Android Emulator, then build and start the standalone Hub:

```sh
bun install --frozen-lockfile
bun run build
bun packages/expo-device-hub/dist/server/cli.mjs \
  --platform android \
  --android-capture-source grpc-stream \
  --port 3400
```

Open `http://127.0.0.1:3400`. The Android Stream options panel can switch the
Capture source between scrcpy and gRPC stream independently of the browser
Transport setting.

The authoritative server state is also visible at:

```sh
curl 'http://127.0.0.1:3400/vendor/serve-emu/api?device=emulator-5554'
curl 'http://127.0.0.1:3400/vendor/serve-emu/api/stream-mode?device=emulator-5554'
```

## V0 boundaries

- `grpc-stream` uses the existing serve-emu RGB888 `streamScreenshot` ->
  ffmpeg/libx264 -> H.264 pipeline. Raw image frames do not cross into the
  browser.
- For compatibility in this v0, `grpc-screenshot` reaches the same
  server-streaming implementation. Splitting it into a true unary polling
  comparison mode belongs to the production implementation plan.
- Capture still uses the configured maximum dimension rather than live
  viewport demand.
- The existing gRPC parser allocation and fixed receive ceiling remain in
  place. Buffer leasing, dynamic receive sizing, and finer `Image.seq` drop
  attribution are production-hardening work.
- Capture-source state is polled from the existing device-scoped API. Runtime
  switches keep serve-emu's current staged session replacement behavior.

## Success signal

The prototype is successful when all of the following are true:

1. The Hub UI reports `gRPC stream` as the selected Capture source.
2. `/api` reports `streamMode: "grpc-stream"`.
3. `/health` reports an increasing encoded-frame count while the gRPC session
   is active. The existing capture diagnostics derive sequence gaps from
   `Image.seq` (and are included in WebRTC statistics when that transport is
   enabled).
4. The browser presents emulator frames through the existing canvas/video
   surface, and touch/input still use the same selected serve-emu session.

## Result recorded on the v0 branch

The built standalone Hub was exercised against the local `Pixel_10` AVD. Its
device API reported `grpc-stream`, RGB capture resolved to 570×1280, and a
forced UI transition advanced the encoded frame counter from 487 to 534. A
client connected through the Hub's real WebSocket proxy and received a 30 KB
SEMU-framed Annex-B H.264 keyframe. Runtime switches from `grpc-stream` to
`scrcpy` and back completed atomically, advancing `sessionGeneration` from 0
to 2.

The automated in-app browser target was unavailable for this run, so direct
visual confirmation of the final canvas paint remains a manual smoke check.
The server data path, browser wire payload, built UI contract, and source
selector rendering are covered by the checks above and the repository tests.
