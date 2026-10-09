/**
 * Test stand-in for `@paperclipai/plugin-sdk/ui`.
 *
 * In Paperclip the host app provides this module at runtime; the UI test project aliases it to
 * this file (see vitest.config.ts). Tests drive it through `sdkUi` (re-exported by ./ui.tsx).
 * Types still come from the real SDK. When `src/ui` starts importing another hook or component,
 * add a stand-in here.
 */
import { useSyncExternalStore } from "react";
import type {
  HostLocation,
  HostNavigation,
  PluginActionFn,
  PluginDataResult,
  PluginHostContext,
  PluginStreamResult,
  PluginToastInput,
} from "@paperclipai/plugin-sdk/ui";

export type * from "@paperclipai/plugin-sdk/ui";

const DEFAULT_HOST_CONTEXT: PluginHostContext = {
  companyId: "company-1",
  companyPrefix: "C1",
  projectId: null,
  entityId: null,
  entityType: null,
  userId: "user-owner-1",
};

type Listener = () => void;

function createStore() {
  let version = 0;
  const listeners = new Set<Listener>();
  const state = {
    hostContext: { ...DEFAULT_HOST_CONTEXT } as PluginHostContext,
    location: { pathname: "/C1/boardroom", search: "", hash: "" } as HostLocation,
    data: new Map<string, Partial<PluginDataResult<unknown>>>(),
    actions: new Map<string, PluginActionFn>(),
    streams: new Map<string, unknown[]>(),
    toasts: [] as PluginToastInput[],
    navigations: [] as string[],
  };

  function changed() {
    version += 1;
    for (const listener of listeners) listener();
  }

  return {
    state,
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getVersion: () => version,

    reset() {
      state.hostContext = { ...DEFAULT_HOST_CONTEXT };
      state.location = { pathname: "/C1/boardroom", search: "", hash: "" };
      state.data.clear();
      state.actions.clear();
      state.streams.clear();
      state.toasts.length = 0;
      state.navigations.length = 0;
      changed();
    },
    setHostContext(patch: Partial<PluginHostContext>) {
      state.hostContext = { ...state.hostContext, ...patch };
      changed();
    },
    setData<T>(key: string, result: Partial<PluginDataResult<T>>) {
      state.data.set(key, result as Partial<PluginDataResult<unknown>>);
      changed();
    },
    setAction(key: string, fn: PluginActionFn) {
      state.actions.set(key, fn);
    },
    pushStreamEvent(channel: string, event: unknown) {
      state.streams.set(channel, [...(state.streams.get(channel) ?? []), event]);
      changed();
    },
    get toasts() {
      return state.toasts;
    },
    get navigations() {
      return state.navigations;
    },
  };
}

export const sdkUi = createStore();

function useStoreVersion() {
  useSyncExternalStore(sdkUi.subscribe, sdkUi.getVersion, sdkUi.getVersion);
}

function resolveHref(to: string): string {
  const prefix = sdkUi.state.hostContext.companyPrefix;
  if (!prefix || !to.startsWith("/") || to.startsWith(`/${prefix}/`)) return to;
  return `/${prefix}${to}`;
}

export function useHostContext(): PluginHostContext {
  useStoreVersion();
  return sdkUi.state.hostContext;
}

export function useHostLocation(): HostLocation {
  useStoreVersion();
  return sdkUi.state.location;
}

export function useHostNavigation(): HostNavigation {
  useStoreVersion();
  const navigate = (to: string) => {
    sdkUi.state.navigations.push(resolveHref(to));
  };
  return {
    resolveHref,
    navigate,
    linkProps: (to: string) => ({
      href: resolveHref(to),
      onClick: (event: { preventDefault(): void }) => {
        event.preventDefault();
        navigate(to);
      },
    }),
  } as HostNavigation;
}

export function usePluginData<T = unknown>(key: string): PluginDataResult<T> {
  useStoreVersion();
  const result = sdkUi.state.data.get(key) ?? {};
  return {
    data: (result.data ?? null) as T | null,
    loading: result.loading ?? false,
    error: result.error ?? null,
    refresh: result.refresh ?? (() => {}),
  };
}

export function usePluginAction(key: string): PluginActionFn {
  return (params) => {
    const fn = sdkUi.state.actions.get(key);
    if (!fn) return Promise.reject(new Error(`Unmocked plugin action: ${key}`));
    return fn(params);
  };
}

export function usePluginStream<T = unknown>(channel: string): PluginStreamResult<T> {
  useStoreVersion();
  const events = (sdkUi.state.streams.get(channel) ?? []) as T[];
  return {
    events,
    lastEvent: events.at(-1) ?? null,
    connecting: false,
    connected: true,
    error: null,
    close: () => {},
  };
}

export function usePluginToast() {
  return (input: PluginToastInput) => {
    sdkUi.state.toasts.push(input);
    return null;
  };
}
