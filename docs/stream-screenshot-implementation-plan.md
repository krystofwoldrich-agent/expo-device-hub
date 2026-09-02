# Plan: additive Android Emulator `streamScreenshot` capture

Date: 2026-09-02

## Outcome

Add a third Android capture mode, `grpc-stream`, while keeping the browser-facing video protocols unchanged:

| Capture mode | Emulator acquisition | Browser delivery |
| --- | --- | --- |
| `scrcpy` | scrcpy server produces H.264 | Existing WebSocket or WebRTC path |
| `grpc-screenshot` | Repeated unary `getScreenshot(RGB888)` calls | Host ffmpeg produces the existing H.264 packets |
| `grpc-stream` | One server-streaming `streamScreenshot(RGB888)` call | Host ffmpeg produces the existing H.264 packets |

The default remains `scrcpy`. Both gRPC modes are offered only for Android Emulator serials. Exact selections do not silently fall back: a failed runtime switch leaves the old capture generation running and reports the failure.

The new mode is selectable from:

- `serve-emu --stream-mode grpc-stream`
- `expo-device-hub --android-capture-source grpc-stream`
- the standalone serve-emu “Stream source” panel
- Expo Device Hub’s “Stream options” panel, in a Capture source control kept separate from browser Transport and codec controls

The requested product semantics take precedence on this experimental branch: `grpc-screenshot` means unary polling and `grpc-stream` means server push. If `grpc-screenshot` has already been released elsewhere with a different meaning, add a temporary `grpc-poll` migration alias rather than changing a stable value silently.

## Important starting-point finding

The checked-out serve-emu revision, `c4f1c051`, already opens `streamScreenshot` for its live RGB path. It exposes that implementation as `grpc-screenshot`; its remaining unary PNG `getScreenshot` calls are bounded startup/wakeup and native-geometry probes, not the live frame loop.

Implementation therefore starts by separating behavior that is currently conflated:

1. Move the existing server-pushed implementation behind the new `grpc-stream` value.
2. Add or port a non-overlapping unary RGB polling producer for `grpc-screenshot`.
3. Keep occasional PNG geometry probes private to the session. The acceptance condition is “no unary frame polling in `grpc-stream`,” not necessarily “zero unary calls of any kind.” Removing the probes is a separate geometry-discovery improvement.

The protocol and Android Studio findings behind this plan are recorded in [stream-screenshot-research.md](./stream-screenshot-research.md).

## Recommended Module and Seam

Keep the existing `EmuSession`/`startEmuSession` Interface as the deep public Module used by the Bun server and middleware. It already hides source startup, input, H.264 packet production, failures, and cleanup. Do not expose raw PNG/RGB/RGBA frames to those callers or introduce another browser wire protocol.

Place one narrow internal Seam inside the gRPC implementation:

```ts
type GrpcCaptureMethod = "unary-poll" | "server-stream";

type GrpcCaptureRequest = Readonly<{
  method: GrpcCaptureMethod;
  width: number;
  height: number;
  format: "rgb888";
  maxFps: number;
  maxMessageBytes: number;
}>;

interface EmulatorFrameSource {
  run(
    request: GrpcCaptureRequest,
    sink: LatestFrameSink,
    signal: AbortSignal,
  ): Promise<void>;
}

interface LatestFrameSink {
  offer(frame: FrameLease): void;
  inactive(metadata: FrameMetadata): void;
}

interface FrameLease {
  readonly width: number;
  readonly height: number;
  readonly seq: number | null;
  readonly timestampUs: bigint | null;
  readonly bytes: Buffer;
  retain(): FrameLease;
  release(): void;
}
```

The two internal Adapters are:

- `UnaryScreenshotFrameSource`: at most one `getScreenshot` request is in flight; it waits for the remaining frame interval after each response and never overlaps requests.
- `StreamingScreenshotFrameSource`: opens exactly one `streamScreenshot` request for a capture generation and emits only callbacks from that request. It never schedules `getScreenshot` for frame delivery.

`grpc-session.ts` remains the shared Implementation for probing, input geometry, newest-frame scheduling, RGB-to-H.264 encoding, packet delivery, diagnostics, and shutdown. `stream-session.ts` maps the public modes to the internal method:

```ts
scrcpy            -> startScrcpy(...)
grpc-screenshot   -> startGrpcSession({ captureMethod: "unary-poll", ... })
grpc-stream       -> startGrpcSession({ captureMethod: "server-stream", ... })
```

Android Emulator gRPC is a true external dependency. Define an injectable private `EmulatorControllerPort` above the hand-written HTTP/2/protobuf client, with only `getScreenshot` and `streamScreenshot` operations. The production Adapter owns endpoint discovery, authentication, gRPC framing/status, protobuf parsing, compression policy, receive limits, and cancellation. A scripted test Adapter produces deterministic frames, gaps, empty frames, errors, and cancellation without requiring an emulator.

This placement provides Depth without a speculative media graph: the outer Interface stays small; the new Seam exists exactly where two real acquisition implementations and a useful fake differ. It gives Leverage to both servers, both CLIs, and both UIs while preserving Locality for protocol and buffer-ownership rules.

## Alternatives considered

### 1. Literal mode branch in `grpc-session.ts`

Extend `STREAM_MODES`, then put an `if` around the current RPC call. This is the smallest diff, but it leaves polling, streaming, cancellation, pacing, buffer ownership, and diagnostics entangled in an already large session function. It is a shallow Interface to the protocol and makes deterministic testing harder.

### 2. Capability-driven media graph

Model capture source, acquisition, source format, processor, output format, and delivery as independently discoverable Adapters with a planner. This has excellent future extensibility for MMAP, RGBA, raw-image delivery, or another encoder. It is too much mechanism for one additional acquisition method and would require replacing stable HTTP and UI contracts in the same change.

### 3. Caller-first `ResponsiveCapture`

Expose `select(source)`, `updateViewer(viewport)`, and `snapshot()` while the Module owns source switching and automatic resolution. This is an attractive eventual boundary, especially because source switching is duplicated between standalone and middleware hosts. Moving all host lifecycle and fallback policy at the same time makes the first `grpc-stream` delivery unnecessarily risky.

### Chosen hybrid

Preserve the existing deep `EmuSession` Interface, introduce the private `EmulatorFrameSource` and `EmulatorControllerPort` Seams, and add viewport demand through existing session/control machinery. Revisit a shared `ResponsiveCapture` coordinator after the two modes and their performance invariants are proven. Do not add automatic fallback now; it would hide failures in the experimental source.

## Data-path contract

```text
Emulator Controller RGB888 image
  -> identity-only gRPC envelope
  -> bounded reusable parser/frame leases
  -> one newest-pending raw-frame slot
  -> ffmpeg/libx264
  -> existing ordered H.264 VideoPacket stream
  -> WebSocket or WebRTC
  -> WebCodecs/video renderer with one newest decoded frame pending
```

The raw gRPC frames are complete independent images; they are safe to replace with a newer image. Encoded H.264 delta packets are not independent and must not be dropped arbitrarily. Preserve the existing ordered/keyframe-aware delivery behavior after encoding.

### Format and validation

- Use `RGB888` for both live gRPC modes because ffmpeg already consumes `rgb24` and the proto calls out PNG encoding cost.
- Keep PNG for occasional still/probe calls only.
- Validate the returned nested format, positive dimensions, rotation, and exactly `width * height * 3` payload bytes before offering a frame.
- Treat `width = 0 && height = 0` as the protocol’s display-inactive event. During startup, wake once and wait for a usable frame with a deadline. After startup, surface inactive state and do not present the stale last frame as live content.
- Normalize or explicitly carry bottom-up row order and rotation at the gRPC Adapter boundary. Verify the current ffmpeg rotation with a labeled real-emulator fixture before retaining it.

### Receive limit and compression

Resolve native geometry before opening a native-size stream, then calculate a per-capture bound with checked integer arithmetic:

```ts
rawBytes = checkedMultiply(requestWidth, requestHeight, 3);
maxMessageBytes = checkedAdd(rawBytes, 64 * 1024);
```

The result is strictly greater than `width * height * 3` and includes protobuf/gRPC envelope allowance. Reject the configuration before allocation if it exceeds the process safety ceiling. Align gRPC capture with the existing 4096-pixel runtime ceiling; do not retain the current mismatch where `grpc-session` accepts 16,384 while the parser caps messages at 64 MiB. Small unary control calls keep their small limits.

Make identity compression explicit:

- request envelope compressed flag is `0`
- send `grpc-encoding: identity`
- send `grpc-accept-encoding: identity`
- accept only an absent or `identity` response encoding
- reject a compressed response flag before allocating/decoding its body

### Buffer and backpressure ownership

Replace per-message `Buffer.allocUnsafe(length)` with a bounded pool sized for the resolved request. The steady-state budget is one buffer being assembled, one owned by/in flight to ffmpeg, and one newest pending buffer. A newer pending frame releases the superseded lease immediately.

Extend `H264Encoder.write` with a completion callback or lease-aware input so a buffer returns to the pool only after Node’s writable no longer references it. Idle repeats retain/release the current frame explicitly. Never reuse a buffer merely because `Writable.write` returned `true`; that return value is a backpressure signal, not an ownership-completion signal.

Host-side pacing may cap work to `maxFps`, but the streaming Adapter still owns one long-lived server stream. Pause/resume the HTTP/2 readable and keep only the newest already-arrived complete message; do not create a timer that calls the unary RPC.

### Dropped-frame accounting

Reset counters per capture generation and report separate layers:

- `emulatorSequenceGaps`: positive gaps in `Image.seq` for `grpc-stream`
- `rawFramesSuperseded`: complete raw frames replaced locally before encoding
- `encoderBackpressureDrops`: frames not submitted because the encoder is busy
- `decodedFramesSuperseded`: decoded browser frames replaced before paint
- source timestamp interval and production-to-receive latency from `timestampUs`

Unary `getScreenshot` always reports `seq = 0`, so sequence-gap metrics are unavailable for `grpc-screenshot`; expose them as `null`, not zero. Treat a sequence reset as a new generation/epoch and handle `uint32` wrap without inventing a huge gap.

## Resolution demand

`maxSize`/`maxDimension` remains an administrator ceiling, not the actual request size. For `grpc-stream`, calculate the actual request from visible render demand:

1. Each browser observes the device-content element with `ResizeObserver` and computes physical pixels from its content box and `devicePixelRatio`.
2. It sends a `capture-viewport` control message containing physical `width`, `height`, and `visible` state over the existing bidirectional WebSocket. WebRTC already retains an input/control WebSocket, so it uses the same path.
3. The server ties the hint to that client connection and removes it on disconnect.
4. For the one shared device stream, resolve the largest scale required by any visible viewer against the current native aspect ratio, then clamp it to native resolution and the configured maximum dimension.
5. With no viewer hint, use the current 1280-long-edge default so capture can start before a UI connects.
6. Debounce growth/reorientation and apply a longer shrink hysteresis. Do nothing when the resolved request is unchanged.
7. Because an `ImageFormat` request is immutable, stage a replacement stream/encoder and publish it only after its first valid keyframe. On failure, keep the old generation.

This policy prevents last-writer-wins races between multiple UIs. A shared feed may still be larger than a small viewer needs when another viewer is larger; per-viewer capture would multiply emulator and encoder cost and is out of scope.

For the initial merge, the viewport contract can be feature-gated behind `grpc-stream`. If dynamic resizing proves too large for the first pull request, the release blocker is still a bounded explicit `maxDimension` that matches the largest expected UI; native/zero must not be the default for server push.

## Public contracts and controls

### serve-emu

In `packages/serve-emu/packages/serve-emu/src/shared/api-contracts.ts`:

```ts
export const STREAM_MODES = [
  "scrcpy",
  "grpc-screenshot",
  "grpc-stream",
] as const;
```

Keep the existing authenticated, device-scoped `GET/PUT /api/stream-mode` Interface and its `{ mode, availableModes, sessionGeneration }` response. Emulator devices return all three modes; physical devices return only `scrcpy`. Keep source and viewer transport as independent axes.

The existing `GET/PATCH /api/stream-settings` continues to own the resolution ceiling, bitrate, and output FPS. Extend its response with effective capture dimensions only if the UI needs to explain the active viewport-derived request; do not make effective state writable.

### CLIs

In serve-emu, extend the existing flag and help text:

```text
--stream-mode scrcpy|grpc-screenshot|grpc-stream
```

In Expo Device Hub, add a deliberately Android-qualified flag:

```text
--android-capture-source scrcpy|grpc-screenshot|grpc-stream
```

Do not reuse `--transport`: that flag selects browser delivery (`mjpeg`, `h264`, or `webrtc`). Do not restore the ambiguous root `--stream-mode` flag, which the current CLI intentionally rejects. Reject `--android-capture-source` with `--platform ios`; allow it when the platform is Android or unspecified.

Map the value through `CliOptions` -> `StandaloneServeEmuOptions.streamMode` -> `createRouter(...)` via `EXPO_DEVICE_HUB_SERVE_EMU_OPTIONS`.

### Expo Device Hub client Interface

Do not add these values to `DeviceStreamMode`, which is viewer delivery. Add one nested, optional capture controller:

```ts
export type AndroidCaptureSource =
  | "scrcpy"
  | "grpc-screenshot"
  | "grpc-stream";

export type DeviceCaptureController = {
  mode: AndroidCaptureSource;
  availableModes: readonly AndroidCaptureSource[];
  generation: number;
  pending: boolean;
  error: string | null;
  setMode(mode: AndroidCaptureSource): void;
};

interface DeviceClient {
  // Existing fields...
  capture: DeviceCaptureController | null;
}
```

The Android Adapter polls the device-scoped `/api/stream-mode`, applies only responses for its current device scope, sends device-scoped PUTs, and reconnects video when `sessionGeneration` changes. iOS and noop Adapters return `capture: null`.

For Android resolution controls, parse and patch `/api/stream-settings` instead of continuing to expose `streamSettings: null`. Make the shared encoder settings shape represent common H.264 fields plus optional iOS-only MJPEG fields, so the UI does not invent MJPEG settings for serve-emu.

### UIs

- Standalone serve-emu: extend `stream-mode-panel.tsx` with “gRPC polling” and “gRPC stream (experimental)” cards, authoritative pending/error state, and clear copy that only the second is event-driven. Add the maximum-size ceiling/effective size to this panel or a neighboring settings panel.
- Expo Device Hub: add a Capture source row above Transport in `StreamOptionsSection.tsx` only when `client.capture` is non-null. Use a Select or radio cards rather than squeezing three long labels into the existing transport segmented control. Keep Max size, FPS, and bitrate controls beneath it.
- Both WebCodecs canvas renderers: retain one newest decoded `VideoFrame` for the next animation frame, close the replaced frame immediately, cache the canvas context, resize the canvas only when dimensions change, and close the painted frame. The standalone worker already approximates this policy; reduce its decoded-frame capacity to one and bring `useAndroidDevice.ts` to the same behavior.
- Browser decoders continue consuming H.264. They do not receive raw gRPC images, recreate textures per frame, or queue independent screenshots.

## Implementation sequence

### 1. Lock the additive contract

- Extend `STREAM_MODES`, parsers, route contracts, help, README, and type-level exhaustiveness.
- Add contract tests that preserve `scrcpy` as default and restrict both gRPC modes to emulator serials.
- Add CLI parsing tests before changing capture behavior.

Primary serve-emu files:

- `src/shared/api-contracts.ts`
- `src/cli.ts`
- `src/stream-session.ts`
- `tests/api-contracts.test.ts`
- `tests/api-routes.test.ts`
- `tests/server-stream-mode.test.ts`
- `tests/middleware-router.test.ts`

### 2. Extract the acquisition Seam

- Add `src/grpc-capture.ts` with the two `EmulatorFrameSource` Adapters and latest-frame/lease contract.
- Make `startGrpcSession` take the exact gRPC capture method and report the exact public mode.
- Move the existing `streamScreenshot` call into the streaming Adapter.
- Implement the unary Adapter as a serial, abortable RGB request loop paced from response completion.
- Inject `EmulatorControllerPort` through `GrpcSessionDependencies` for tests.
- Preserve current input/control and downstream H.264 packet contracts.

Primary files:

- `src/grpc-capture.ts` (new)
- `src/grpc-session.ts`
- `src/stream-session.ts`
- `src/emulator-grpc.ts`
- `tests/grpc-session.test.ts`
- `tests/stream-session.test.ts`

### 3. Harden the server-pushed image path

- Add checked request sizing and a per-stream receive limit.
- Make identity compression explicit and validate response headers/envelopes.
- Model inactive frames and all terminal statuses.
- Introduce the bounded pool/leases and encoder completion ownership.
- Split `seq`, local replacement, encoder, and latency diagnostics.

Primary files:

- `src/emulator-grpc.ts`
- `src/grpc-capture.ts`
- `src/grpc-session.ts`
- `src/h264-encoder.ts`
- `src/stream-session.ts`
- `src/webrtc-stats.ts`
- `tests/emulator-grpc.test.ts`
- `tests/h264-encoder.test.ts`
- `tests/grpc-session.test.ts`
- `tests/webrtc-stats.test.ts`

### 4. Reuse runtime switching and add resolution demand

- Route the third mode through the existing serialized, staged source replacement in `server.ts` and `middleware.ts`.
- Add the `capture-viewport` control contract and per-client demand registry.
- Resolve/debounce aggregate demand and restart with generation safety.
- Continue broadcasting video-session size/keyframe resets after publication.
- Preserve authorization and origin checks for every mutation.

Primary files:

- `src/server.ts`
- `src/middleware.ts`
- `src/shared/control-contracts.ts`
- `src/shared/worker-contracts.ts`
- `src/stream-socket.ts`
- `src/device-session-state.ts`
- `tests/server-stream-mode.test.ts`
- `tests/middleware-router.test.ts`
- `tests/stream-settings-http.test.ts`

### 5. Wire both CLIs

- Extend serve-emu’s existing flag.
- Add and validate Expo Device Hub’s Android-specific flag.
- Carry it through the standalone serve-emu environment payload and router defaults.
- Update CLI/README examples so source, transport, resolution, and FPS are visibly separate concepts.

Expo Device Hub files:

- `packages/expo-device-hub/src/server/cli/options.ts`
- `packages/expo-device-hub/src/server/serve-emu-options.ts`
- `packages/expo-device-hub/src/server/serve-emu.ts`
- `packages/expo-device-hub/src/server/__tests__/cli-options.test.ts`
- `packages/expo-device-hub/src/server/__tests__/serve-emu-options.test.ts`

### 6. Wire both UIs

- Extend serve-emu’s source panel and add viewport reporting.
- Add `DeviceCaptureController`, Android polling/mutation, stream settings, and viewport messages in Hub client.
- Render Android capture and resolution controls in the shared options section; omit them for iOS.
- Make decoded-frame painting newest-only in both UIs.

Primary files:

- `packages/serve-emu/packages/serve-emu/src/ui/components/stream-mode-panel.tsx`
- `packages/serve-emu/packages/serve-emu/src/ui/lib/use-stream.ts`
- `packages/serve-emu/packages/serve-emu/src/ui/lib/stream-worker.ts`
- `packages/serve-emu/packages/serve-emu/src/ui/lib/stream-lifecycle.ts`
- `packages/serve-emu/packages/serve-emu/src/ui/styles.css`
- `packages/@expo/hub-client/src/types.ts`
- `packages/@expo/hub-client/src/useAndroidDevice.ts`
- `packages/@expo/hub-client/src/useIosDevice.ts`
- `packages/@expo/hub-client/src/useNoopDeviceClient.ts`
- `packages/@expo/hub-client/src/index.ts`
- `packages/@expo/hub-components/src/dashboard/StreamOptionsSection.tsx`

### 7. Vendor, document, and release

- Build serve-emu before Expo Device Hub so `build:vendor` copies the new contracts/runtime.
- Update the authoritative serve-emu README and its package copy, Expo Device Hub README, changelogs/changeset, and experimental warning.
- Keep submodule changes committed in serve-emu first, then update the root gitlink.

## Test plan

### Pure protocol and Adapter tests

- gRPC envelopes fragmented at every header/body boundary
- request path and encoded RGB width/height
- dynamic receive limit: exact valid maximum accepted; one byte over rejected before body allocation
- compressed bit or non-identity response encoding rejected
- empty -> active -> empty display sequence
- non-zero trailers, clean unexpected EOF, cancellation, and first-frame timeout
- payload length mismatch, format mismatch, invalid dimensions, rotation changes
- `seq` gaps, duplicates, backwards values, generation reset, and `uint32` wrap
- burst producer plus blocked encoder proves one newest pending frame and bounded pool usage
- every lease is released on success, replacement, error, abort, and shutdown

### Session and switching tests

- `grpc-screenshot` calls only unary frame acquisition and never overlaps calls
- `grpc-stream` makes one streaming call and no unary frame-acquisition calls
- all three modes return the same H.264 `EmuSession` packet contract
- physical Android reports only `scrcpy`
- switch waits for a decodable keyframe before publication
- failed switch preserves the old session and authoritative mode
- concurrent switches are serialized; stale generations cannot publish
- stream end is fatal and is not silently converted to scrcpy
- viewport growth, shrink hysteresis, orientation, duplicate demand, and client disconnect

### CLI/API/UI tests

- all three source values accepted; invalid values rejected with complete help
- `--android-capture-source` rejected for explicit iOS and kept distinct from `--transport`
- root env serialization reaches `createRouter` as `streamMode`
- GET/PUT response parsing includes all available modes and generation
- standalone panel renders three choices, disables unavailable modes, and rolls back on failure
- Hub source control appears only for Android, scopes requests by device, disables while pending, and reconnects on generation change
- Android max-size/FPS/bitrate settings round-trip through `/api/stream-settings`
- both renderers replace/close stale decoded frames and retain no frames after cleanup

### Real-emulator interoperability matrix

Run against at least one current stable emulator and one older supported emulator:

- portrait, landscape, reverse portrait, reverse landscape
- static screen, 60 fps animation, display sleep/wake, resize, fold/resizable display if available
- 720, 1280, 1920, and native ceilings
- WebSocket and WebRTC delivery
- source switches in both UIs and both CLIs
- labeled color/orientation fixture verifies row order, channel order, rotation, and touch mapping
- 10-minute over-producing/slow-consumer soak verifies stable heap/RSS and no growing frame queue

## Acceptance criteria

- Selecting `grpc-stream` opens exactly one `streamScreenshot` RPC per capture generation; no timer polls `getScreenshot` for frames.
- `grpc-screenshot` remains a distinct working unary polling option.
- The source can be selected at startup from both CLIs and at runtime from both UIs.
- Source choice is independent of WebSocket/WebRTC transport and H.264 codec settings.
- The emulator receives physical-pixel bounds no larger than the largest visible viewer demand, configured ceiling, or native resolution.
- The receive limit is checked, strictly above the RGB footprint, and below the absolute process cap.
- Generic gRPC compression is identity-only in both directions.
- Raw and decoded image stages keep only the newest pending frame; memory stays bounded and reusable buffers are not overwritten while owned.
- `Image.seq` gaps and local drop layers are observable separately.
- Empty images, stream completion, non-OK status, abort, and resize/reorientation have explicit tested behavior.
- All existing WebSocket/WebRTC streaming and input paths still pass; the full monorepo build succeeds from a frozen lockfile.

## Primary sources

- [Pinned Emulator Controller proto](https://android.googlesource.com/platform/tools/base/+/4e74507c931f725836deee44cd0cea04155d1d19/emulator/proto/emulator_controller.proto)
- [Pinned Android Emulator server implementation](https://android.googlesource.com/platform/external/qemu/+/ae9d18d2b6261179fbd57fffec720a04f7bfb053/android/android-grpc/services/emulator-controller/server/src/android/emulation/control/EmulatorService.cpp)
- [Pinned Android Studio streaming implementation](https://android.googlesource.com/platform/tools/adt/idea/+/dfe5a699e0316e799fc615a0faf2ed97fd24eabc/streaming/src/com/android/tools/idea/streaming/emulator/)
- [Pinned experimental serve-emu revision](https://github.com/expo/serve-emu/tree/c4f1c05192d0d9300b12addac604581fc7ca2ca6)
