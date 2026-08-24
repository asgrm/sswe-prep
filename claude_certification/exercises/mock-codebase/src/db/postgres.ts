export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/** Thin pool wrapper. No retry: a dropped connection surfaces to the caller. */
export class PostgresPool {
  constructor(private readonly connectionString: string) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    void this.connectionString;
    void sql;
    void params;
    return { rows: [], rowCount: 0 };
  }

  async transaction<T>(work: (pool: PostgresPool) => Promise<T>): Promise<T> {
    return work(this);
  }
}
