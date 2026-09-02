import { afterEach, describe, expect, test } from 'bun:test';
import { createElement, act } from 'react';
import { createRequire } from 'node:module';

import { useAndroidDeviceClient } from '../useAndroidDevice';
import { type DeviceClient, type DeviceConnectionOptions } from '../types';

type IntervalRecord = {
  callback: () => unknown;
  delay: number;
};

type FetchCall = {
  url: string;
  init: RequestInit | undefined;
};

type TestSocket = {
  url: string;
  readyState: number;
  closeCalls: number;
};

type TestEnvironment = {
  fetchCalls: FetchCall[];
  intervalRecords: Map<number, IntervalRecord>;
  sockets: TestSocket[];
  restore(): void;
};

type Deferred<Value> = {
  promise: Promise<Value>;
  resolve(value: Value): void;
};

const mountedRoots = new Set<{ unmount(): void }>();
let activeEnvironment: TestEnvironment | null = null;

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

function installEnvironment(
  captureRequest: (url: string, init: RequestInit | undefined) => Promise<Response>,
): TestEnvironment {
  const keys = [
    'window',
    'document',
    'HTMLElement',
    'HTMLIFrameElement',
    'VideoDecoder',
    'EncodedVideoChunk',
    'WebSocket',
    'fetch',
    'setInterval',
    'clearInterval',
    'IS_REACT_ACT_ENVIRONMENT',
  ] as const;
  const descriptors = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const define = (key: (typeof keys)[number], value: unknown) => {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  };

  class FakeElement {}
  const fakeDocument: Record<string, unknown> = {
    nodeType: 9,
    addEventListener() {},
    removeEventListener() {},
  };
  const createFakeElement = (tag: string) =>
    Object.assign(new FakeElement(), {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      nodeName: tag.toUpperCase(),
      ownerDocument: fakeDocument,
      namespaceURI: 'http://www.w3.org/1999/xhtml',
      style: {},
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
      appendChild() {},
      removeChild() {},
    });
  fakeDocument.createElement = createFakeElement;
  fakeDocument.defaultView = globalThis;
  fakeDocument.documentElement = createFakeElement('html');
  fakeDocument.body = createFakeElement('body');
  fakeDocument.activeElement = fakeDocument.body;

  const sockets: TestSocket[] = [];
  class FakeWebSocket {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;

    readyState = 0;
    closeCalls = 0;
    binaryType = '';
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor(readonly url: string) {
      sockets.push(this);
    }

    close(): void {
      this.closeCalls++;
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.();
    }

    send(): void {}
  }

  const fetchCalls: FetchCall[] = [];
  const fetchStub = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = requestUrl(input);
    fetchCalls.push({ url, init });
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/api/stream-mode')) return captureRequest(url, init);
    if (pathname.endsWith('/api')) {
      return response({ stream: { transport: 'websocket' }, size: { width: 570, height: 1280 } });
    }
    if (pathname.endsWith('/api/devices')) return response({ devices: [] });
    if (pathname.endsWith('/api/foreground')) return response({ ok: false });
    return response({ ok: false }, 404);
  };

  let nextIntervalId = 1;
  const intervalRecords = new Map<number, IntervalRecord>();
  const setIntervalStub = (callback: () => unknown, delay = 0): number => {
    const id = nextIntervalId++;
    intervalRecords.set(id, { callback, delay });
    return id;
  };
  const clearIntervalStub = (id: number): void => {
    intervalRecords.delete(id);
  };

  define('window', globalThis);
  define('document', fakeDocument);
  define('HTMLElement', FakeElement);
  define('HTMLIFrameElement', class {});
  define('VideoDecoder', class {});
  define('EncodedVideoChunk', class {});
  define('WebSocket', FakeWebSocket);
  define('fetch', fetchStub);
  define('setInterval', setIntervalStub);
  define('clearInterval', clearIntervalStub);
  define('IS_REACT_ACT_ENVIRONMENT', true);

  return {
    fetchCalls,
    intervalRecords,
    sockets,
    restore() {
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index++) await Promise.resolve();
  });
}

async function fireIntervals(environment: TestEnvironment, delay: number): Promise<void> {
  await act(async () => {
    for (const record of [...environment.intervalRecords.values()]) {
      if (record.delay === delay) await record.callback();
    }
    for (let index = 0; index < 8; index++) await Promise.resolve();
  });
}

async function renderClient(options: DeviceConnectionOptions) {
  let current: DeviceClient | null = null;
  let currentOptions = options;
  const requireFromHub = createRequire(
    new URL('../../../../expo-device-hub/package.json', import.meta.url),
  );
  const { createRoot } = requireFromHub('react-dom/client') as {
    createRoot(container: unknown): {
      render(children: unknown): void;
      unmount(): void;
    };
  };
  const container = (globalThis.document as Document).createElement('div');
  const root = createRoot(container);
  mountedRoots.add(root);

  function Probe() {
    current = useAndroidDeviceClient(currentOptions);
    return null;
  }

  await act(async () => {
    root.render(createElement(Probe));
    for (let index = 0; index < 8; index++) await Promise.resolve();
  });

  return {
    get current(): DeviceClient {
      if (!current) throw new Error('Android client did not render');
      return current;
    },
    async rerender(nextOptions: DeviceConnectionOptions): Promise<void> {
      currentOptions = nextOptions;
      await act(async () => {
        root.render(createElement(Probe));
        for (let index = 0; index < 8; index++) await Promise.resolve();
      });
    },
    async unmount(): Promise<void> {
      mountedRoots.delete(root);
      await act(async () => root.unmount());
    },
  };
}

afterEach(async () => {
  for (const root of mountedRoots) {
    await act(async () => root.unmount());
  }
  mountedRoots.clear();
  activeEnvironment?.restore();
  activeEnvironment = null;
});

describe('Android capture controller', () => {
  test('loads capture state from the selected device endpoint', async () => {
    activeEnvironment = installEnvironment(async () =>
      response({
        ok: true,
        serial: 'emulator-5554',
        mode: 'grpc-stream',
        availableModes: ['scrcpy', 'grpc-stream'],
        sessionGeneration: 7,
      }),
    );

    const rendered = await renderClient({
      baseUrl: 'http://localhost:3400/vendor/serve-emu',
      device: 'emulator-5554',
      streamMode: 'h264',
    });
    await flushEffects();

    expect(
      activeEnvironment.fetchCalls.some(
        ({ url, init }) =>
          url ===
            'http://localhost:3400/vendor/serve-emu/api/stream-mode?device=emulator-5554' &&
          init?.cache === 'no-store',
      ),
    ).toBe(true);
    expect(rendered.current.capture).toMatchObject({
      mode: 'grpc-stream',
      availableModes: ['scrcpy', 'grpc-stream'],
      generation: 7,
      pending: false,
      error: null,
    });

    await rendered.unmount();
  });

  test('keeps the source switch pending until the authoritative PUT response arrives', async () => {
    const update = deferred<Response>();
    activeEnvironment = installEnvironment(async (_url, init) => {
      if (init?.method === 'PUT') return update.promise;
      return response({
        ok: true,
        serial: 'emulator-5554',
        mode: 'scrcpy',
        availableModes: ['scrcpy', 'grpc-stream'],
        sessionGeneration: 2,
      });
    });
    const rendered = await renderClient({
      baseUrl: 'http://localhost:3400/vendor/serve-emu',
      device: 'emulator-5554',
      streamMode: 'h264',
    });
    await flushEffects();

    await act(async () => {
      rendered.current.capture?.setMode('grpc-stream');
      await Promise.resolve();
    });

    expect(rendered.current.capture).toMatchObject({ mode: 'scrcpy', pending: true, error: null });
    const put = activeEnvironment.fetchCalls.find(({ init }) => init?.method === 'PUT');
    expect(put?.url).toBe(
      'http://localhost:3400/vendor/serve-emu/api/stream-mode?device=emulator-5554',
    );
    expect(JSON.parse(String(put?.init?.body))).toEqual({ mode: 'grpc-stream' });

    await act(async () => {
      update.resolve(
        response({
          ok: true,
          serial: 'emulator-5554',
          mode: 'grpc-stream',
          availableModes: ['scrcpy', 'grpc-stream'],
          sessionGeneration: 3,
        }),
      );
      for (let index = 0; index < 8; index++) await Promise.resolve();
    });

    expect(rendered.current.capture).toMatchObject({
      mode: 'grpc-stream',
      generation: 3,
      pending: false,
      error: null,
    });
    await rendered.unmount();
  });

  test('aborts the previous device request and ignores its stale response', async () => {
    const previousDevice = deferred<Response>();
    activeEnvironment = installEnvironment(async (url) => {
      if (new URL(url).searchParams.get('device') === 'emulator-5554') {
        return previousDevice.promise;
      }
      return response({
        ok: true,
        serial: 'emulator-5556',
        mode: 'grpc-stream',
        availableModes: ['scrcpy', 'grpc-stream'],
        sessionGeneration: 9,
      });
    });
    const baseOptions = {
      baseUrl: 'http://localhost:3400/vendor/serve-emu',
      streamMode: 'h264' as const,
    };
    const rendered = await renderClient({ ...baseOptions, device: 'emulator-5554' });
    const previousRequest = activeEnvironment.fetchCalls.find(({ url }) =>
      url.includes('/api/stream-mode?device=emulator-5554'),
    );
    expect(previousRequest).toBeDefined();

    await rendered.rerender({ ...baseOptions, device: 'emulator-5556' });
    await flushEffects();

    expect(previousRequest?.init?.signal?.aborted).toBe(true);
    expect(rendered.current.capture).toMatchObject({
      mode: 'grpc-stream',
      generation: 9,
      pending: false,
    });

    await act(async () => {
      previousDevice.resolve(
        response({
          ok: true,
          serial: 'emulator-5554',
          mode: 'scrcpy',
          availableModes: ['scrcpy', 'grpc-stream'],
          sessionGeneration: 1,
        }),
      );
      for (let index = 0; index < 8; index++) await Promise.resolve();
    });

    expect(rendered.current.capture).toMatchObject({ mode: 'grpc-stream', generation: 9 });
    await rendered.unmount();
  });

  test('preserves the last good source through a polling error and recovers on the next read', async () => {
    let captureReads = 0;
    activeEnvironment = installEnvironment(async () => {
      captureReads++;
      if (captureReads === 2) {
        return response({ ok: false, error: 'Capture feed unavailable' }, 503);
      }
      return response({
        ok: true,
        serial: 'emulator-5554',
        mode: captureReads === 1 ? 'scrcpy' : 'grpc-stream',
        availableModes: ['scrcpy', 'grpc-stream'],
        sessionGeneration: captureReads === 1 ? 4 : 5,
      });
    });
    const rendered = await renderClient({
      baseUrl: 'http://localhost:3400/vendor/serve-emu',
      device: 'emulator-5554',
      streamMode: 'h264',
    });
    await flushEffects();
    expect(rendered.current.capture).toMatchObject({
      mode: 'scrcpy',
      generation: 4,
      error: null,
    });

    await fireIntervals(activeEnvironment, 1_500);
    expect(rendered.current.capture).toMatchObject({
      mode: 'scrcpy',
      generation: 4,
      error: 'Capture feed unavailable',
    });

    await fireIntervals(activeEnvironment, 1_500);
    expect(rendered.current.capture).toMatchObject({
      mode: 'grpc-stream',
      generation: 5,
      error: null,
    });
    await rendered.unmount();
  });

  test('reconnects the H.264 socket when the authoritative capture generation changes', async () => {
    let captureReads = 0;
    activeEnvironment = installEnvironment(async () => {
      captureReads++;
      return response({
        ok: true,
        serial: 'emulator-5554',
        mode: 'grpc-stream',
        availableModes: ['scrcpy', 'grpc-stream'],
        sessionGeneration: captureReads,
      });
    });
    const rendered = await renderClient({
      baseUrl: 'http://localhost:3400/vendor/serve-emu',
      device: 'emulator-5554',
      streamMode: 'h264',
    });
    await flushEffects();

    const h264SocketsBefore = activeEnvironment.sockets.filter(({ url }) =>
      url.includes('/ws?frame-meta=1'),
    );
    const activeSocket = h264SocketsBefore.at(-1);
    expect(activeSocket).toMatchObject({
      url: 'ws://localhost:3400/vendor/serve-emu/ws?frame-meta=1&device=emulator-5554',
      closeCalls: 0,
    });

    await fireIntervals(activeEnvironment, 1_500);

    const h264SocketsAfter = activeEnvironment.sockets.filter(({ url }) =>
      url.includes('/ws?frame-meta=1'),
    );
    expect(rendered.current.capture?.generation).toBe(2);
    expect(activeSocket?.closeCalls).toBe(1);
    expect(h264SocketsAfter).toHaveLength(h264SocketsBefore.length + 1);
    expect(h264SocketsAfter.at(-1)).not.toBe(activeSocket);
    await rendered.unmount();
  });
});
