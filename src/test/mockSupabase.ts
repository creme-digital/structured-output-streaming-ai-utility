import { vi } from "vitest";

export interface FakeError {
  message: string;
}

export interface FakeSupabaseOptions {
  historyRows?: Array<{ id: string; role: string; content: string }>;
  historyError?: FakeError | null;
  insertErrorForTable?: Partial<Record<string, FakeError>>;
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
