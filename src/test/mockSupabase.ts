import { vi } from "vitest";

export interface FakeError {
  message: string;
}

export interface FakeSupabaseOptions {
  historyRows?: Array<Record<string, unknown>>;
  historyError?: FakeError | null;
  insertErrorForTable?: Partial<Record<string, FakeError>>;
}

export interface FakeChannel {
  on: (...args: unknown[]) => FakeChannel;
  subscribe: (...args: unknown[]) => FakeChannel;
  /** Test-only hook: invokes the most recent `on("postgres_changes", ...)` handler,
   * simulating a realtime INSERT event (Cycle 6 / FR-010). */
  emit: (payload: unknown) => void;
}

/**
 * A minimal fake of the `supabase.channel(...).on(...).subscribe()` surface FR-010's
 * `useHistory` hook uses for its realtime subscription. Good enough to unit test
 * insert-driven updates without a live Supabase realtime connection.
 */
export function createFakeChannel(): FakeChannel {
  let handler: ((payload: unknown) => void) | undefined;
  const channel: FakeChannel = {
    on: (...args: unknown[]) => {
      const maybeHandler = args[2];
      if (typeof maybeHandler === "function") {
        handler = maybeHandler as (payload: unknown) => void;
      }
      return channel;
    },
    subscribe: () => channel,
    emit: (payload: unknown) => handler?.(payload),
  };
  return channel;
}

export interface InsertCall {
  table: string;
  payload: Record<string, unknown>;
}

export interface FakeQueryBuilder {
  select: () => FakeQueryBuilder;
  eq: () => FakeQueryBuilder;
  order: () => Promise<{ data: unknown; error: FakeError | null }>;
  insert: (payload: Record<string, unknown>) => Promise<{ data: unknown; error: FakeError | null }>;
}

/**
 * A minimal fake of the subset of the supabase-js query builder this app uses:
 * `.from(table).select(...).eq(...).order(...)` (history load) and
 * `.from(table).insert(payload)` (writes). Good enough to unit test the app's
 * logic without a live Supabase project or network access.
 */
export function createFakeSupabaseTables(options: FakeSupabaseOptions = {}) {
  const insertCalls: InsertCall[] = [];
  const channels = new Map<string, FakeChannel>();

  function builderFor(table: string): FakeQueryBuilder {
    const builder: FakeQueryBuilder = {
      select: () => builder,
      eq: () => builder,
      order: () =>
        Promise.resolve({
          data: options.historyRows ?? [],
          error: options.historyError ?? null,
        }),
      insert: (payload: Record<string, unknown>) => {
        insertCalls.push({ table, payload });
        const error = options.insertErrorForTable?.[table] ?? null;
        return Promise.resolve({ data: error ? null : [payload], error });
      },
    };
    return builder;
  }

  return {
    from: vi.fn((table: string): FakeQueryBuilder => builderFor(table)),
    insertCalls,
    // Cycle 6 / FR-010: `useHistory` calls `supabase.channel(name)` — return (and
    // remember, keyed by name) the same fake channel each time so a test can grab it
    // via `channels.get(name)` and call `.emit(...)` to simulate a realtime INSERT.
    channel: vi.fn((name: string): FakeChannel => {
      const existing = channels.get(name);
      if (existing) return existing;
      const created = createFakeChannel();
      channels.set(name, created);
      return created;
    }),
    removeChannel: vi.fn(),
    channels,
  };
}

export interface FakeSession {
  user: { id: string; email: string };
}

export function createFakeSupabaseAuth() {
  return {
    getSession: vi.fn(() =>
      Promise.resolve<{ data: { session: FakeSession | null } }>({ data: { session: null } }),
    ),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    signUp: vi.fn(() =>
      Promise.resolve<{ data: { session: FakeSession | null }; error: FakeError | null }>({
        data: { session: { user: { id: "new-user", email: "new@example.com" } } },
        error: null,
      }),
    ),
    signInWithPassword: vi.fn(() => Promise.resolve<{ error: FakeError | null }>({ error: null })),
    signOut: vi.fn(() => Promise.resolve<{ error: FakeError | null }>({ error: null })),
  };
}
