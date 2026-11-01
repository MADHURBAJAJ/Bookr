import postgres from 'postgres';

export type Sql = postgres.Sql;

// One small client per request. Hyperdrive pools the real connections, so this is cheap on Workers.
export function makeSql(connectionString: string): Sql {
  return postgres(connectionString, { max: 5, fetch_types: false });
}

// Either a plain client or one inside sql.begin().
export type Query = postgres.Sql | postgres.TransactionSql;
