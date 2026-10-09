/**
 * Test stand-in for `@paperclipai/plugin-sdk/ui`.
 *
 * In Paperclip the host app provides this module at runtime; the UI test project aliases it to
 * this file (see vitest.config.ts). Tests drive it through `sdkUi` (re-exported by ./ui.tsx).
 * Types still come from the real SDK. When `src/ui` starts importing another hook or component,
 * add a stand-in here.
 */
import { useSyncExternalStore, type ReactNode } from "react";
import type {
  HostLocation,
  HostNavigation,
  PluginActionFn,
  PluginDataResult,
  PluginHostContext,
  PluginStreamResult,
  PluginToastInput,
  ProjectPickerProps,
  SpinnerProps,
  StatusBadgeProps,
  MarkdownBlockProps,
  MarkdownEditorProps,
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
    /** The options of the latest `usePluginStream(channel, options)` call, per channel. */
    streamOptions: new Map<string, { companyId?: string } | undefined>(),
    toasts: [] as PluginToastInput[],
    navigations: [] as string[],
    projects: [] as { id: string; name: string }[],
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
      state.streamOptions.clear();
      state.toasts.length = 0;
      state.navigations.length = 0;
      state.projects = [];
      changed();
    },
    setHostContext(patch: Partial<PluginHostContext>) {
      state.hostContext = { ...state.hostContext, ...patch };
      changed();
    },
    setLocation(pathname: string, search = "") {
      state.location = { pathname, search, hash: "" };
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
    const href = resolveHref(to);
    sdkUi.state.navigations.push(href);
    // Like the host router: the location follows the navigation.
    const [path = href, search = ""] = href.split("?");
    sdkUi.setLocation(path, search ? `?${search}` : "");
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

export function usePluginStream<T = unknown>(channel: string, options?: { companyId?: string }): PluginStreamResult<T> {
  useStoreVersion();
  sdkUi.state.streamOptions.set(channel, options);
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

// Stand-ins for the host-provided shared components. They render plain, queryable markup.

export function StatusBadge({ label, status }: StatusBadgeProps) {
  return <span data-testid="status-badge" data-status={status}>{label}</span>;
}

export function Spinner({ label }: SpinnerProps) {
  return <span role="status" aria-label={label ?? "Loading"} data-testid="spinner" />;
}

export function MarkdownBlock({ content }: MarkdownBlockProps): ReactNode {
  return <div data-testid="markdown-block">{content}</div>;
}

/** A native select over `sdkUi.state.projects`, so tests can pick a project by name. */
export function ProjectPicker({ value, onChange, placeholder, noneLabel }: ProjectPickerProps) {
  useStoreVersion();
  return (
    <select aria-label={placeholder ?? "Project"} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{noneLabel ?? "No project"}</option>
      {sdkUi.state.projects.map((project) => (
        <option key={project.id} value={project.id}>
          {project.name}
        </option>
      ))}
    </select>
  );
}

/** A plain textarea; `onSubmit` runs on Ctrl+Enter, like the host editor's Cmd/Ctrl+Enter. */
export function MarkdownEditor({ value, onChange, placeholder, readOnly, onSubmit }: MarkdownEditorProps) {
  return (
    <textarea
      data-testid="markdown-editor"
      aria-label={placeholder ?? "Markdown editor"}
      placeholder={placeholder}
      readOnly={readOnly}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) onSubmit?.();
      }}
    />
  );
}
