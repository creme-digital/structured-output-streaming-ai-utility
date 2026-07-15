import { vi } from "vitest";

export interface FakeError {
  message: string;
}

export interface FakeSupabaseOptions {
  historyRows?: Array<Record<string, unknown>>;
  historyError?: FakeError | null;
  /** Cycle 8: per-table read rows for `.select(...).order(...)` chains. Falls back to
   * `historyRows` for any table without an entry, preserving older tests. */
  rowsForTable?: Partial<Record<string, Array<Record<string, unknown>>>>;
  insertErrorForTable?: Partial<Record<string, FakeError>>;
  updateErrorForTable?: Partial<Record<string, FakeError>>;
}

export interface FakeChannel {
  on: (...args: unknown[]) => FakeChannel;
  subscribe: (...args: unknown[]) => FakeChannel;
  /** Test-only hook: invokes the handler registered for `event` (default "INSERT"),
   * simulating a realtime event (Cycle 6 / FR-010; UPDATE added in Cycle 8). */
  emit: (payload: unknown, event?: string) => void;
}

/**
 * A minimal fake of the `supabase.channel(...).on(...).subscribe()` surface FR-010's
 * `useHistory` hook uses for its realtime subscription. Handlers are kept per event
 * type (Cycle 8: the hook now registers both INSERT and UPDATE), so `emit` can target
 * either without one registration clobbering the other.
 */
export function createFakeChannel(): FakeChannel {
  const handlers = new Map<string, (payload: unknown) => void>();
  const channel: FakeChannel = {
    on: (...args: unknown[]) => {
      const config = args[1] as { event?: string } | undefined;
      const maybeHandler = args[2];
      if (typeof maybeHandler === "function") {
        handlers.set(config?.event ?? "INSERT", maybeHandler as (payload: unknown) => void);
      }
      return channel;
    },
    subscribe: () => channel,
    emit: (payload: unknown, event = "INSERT") => handlers.get(event)?.(payload),
  };
  return channel;
}

export interface InsertCall {
  table: string;
  payload: Record<string, unknown>;
}

/** Cycle 8: one recorded `.update(payload).eq(...)...` call, filters keyed by column. */
export interface UpdateCall {
  table: string;
  payload: Record<string, unknown>;
  filters: Record<string, unknown>;
}

type FakeReadResult = Promise<{ data: unknown; error: FakeError | null }> & {
  limit: (count: number) => Promise<{ data: unknown; error: FakeError | null }>;
};

type FakeUpdateChain = Promise<{ data: unknown; error: FakeError | null }> & {
  eq: (column: string, value: unknown) => FakeUpdateChain;
};

export interface FakeQueryBuilder {
  select: () => FakeQueryBuilder;
  eq: () => FakeQueryBuilder;
  ilike: () => FakeQueryBuilder;
  order: () => FakeReadResult;
  insert: (payload: Record<string, unknown>) => Promise<{ data: unknown; error: FakeError | null }>;
  update: (payload: Record<string, unknown>) => FakeUpdateChain;
}

/**
 * A minimal fake of the subset of the supabase-js query builder this app uses:
 * `.from(table).select(...).eq/.ilike(...).order(...)[.limit(...)]` (reads) and
 * `.from(table).insert(payload)` / `.from(table).update(payload).eq(...)` (writes,
 * update added in Cycle 8). Good enough to unit test the app's logic without a live
 * Supabase project or network access.
 */
export function createFakeSupabaseTables(options: FakeSupabaseOptions = {}) {
  const insertCalls: InsertCall[] = [];
  const updateCalls: UpdateCall[] = [];
  const channels = new Map<string, FakeChannel>();

  function builderFor(table: string): FakeQueryBuilder {
    const builder: FakeQueryBuilder = {
      select: () => builder,
      eq: () => builder,
      ilike: () => builder,
      order: () => {
        const result = Promise.resolve({
          data: options.rowsForTable?.[table] ?? options.historyRows ?? [],
          error: options.historyError ?? null,
        });
        // `.order(...)` is awaited directly by some callers and chained with
        // `.limit(n)` by others — supabase-js supports both, so the fake does too.
        return Object.assign(result, { limit: () => result });
      },
      insert: (payload: Record<string, unknown>) => {
        insertCalls.push({ table, payload });
        const error = options.insertErrorForTable?.[table] ?? null;
        return Promise.resolve({ data: error ? null : [payload], error });
      },
      update: (payload: Record<string, unknown>) => {
        const call: UpdateCall = { table, payload, filters: {} };
        updateCalls.push(call);
        const error = options.updateErrorForTable?.[table] ?? null;
        const promise = Promise.resolve({ data: error ? null : [payload], error });
        const chain: FakeUpdateChain = Object.assign(promise, {
          eq: (column: string, value: unknown) => {
            call.filters[column] = value;
            return chain;
          },
        });
        return chain;
      },
    };
    return builder;
  }

  return {
    from: vi.fn((table: string): FakeQueryBuilder => builderFor(table)),
    insertCalls,
    updateCalls,
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
