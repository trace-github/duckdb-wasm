import { Logger, VoidLogger } from './log.js';
import { AsyncDuckDB } from './parallel/index.js';

export interface DuckDBBundle {
  mainModule: string;
  mainWorker: string;
  pthreadWorker?: string;
}

export async function duckdb(config: DuckDBBundle, logger?: Logger) {
  const worker = new Worker(config.mainWorker);
  const db = new AsyncDuckDB(logger ?? new VoidLogger(), worker);
  await db.instantiate(config.mainModule, config.pthreadWorker);
  return db;
}
