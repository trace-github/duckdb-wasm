// Shared native quack host used by both the Node demo and the browser demo.
// Native DuckDB via @duckdb/node-api: loads quack, seeds a table, registers a
// server-side UDF, and starts quack_serve over HTTP.
import { DuckDBInstance, DuckDBScalarFunction, DOUBLE, INTEGER } from '@duckdb/node-api';

export async function startHost({ uri = 'quack:localhost:9494', token = 'super_secret', log = () => {} } = {}) {
  log('starting native DuckDB (@duckdb/node-api)…');
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();

  log('loading quack extension…');
  await conn.run('INSTALL quack');
  await conn.run('LOAD quack');

  log('creating demo table products…');
  await conn.run(`CREATE TABLE products AS
    SELECT * FROM (VALUES
      (1, 'widget',  9.99),
      (2, 'gadget', 19.99),
      (3, 'gizmo',  29.99)
    ) AS t(id, name, price)`);

  // Server-side UDF — real JS code that runs on the host. Clients invoke it
  // remotely via quack_query(). loyalty_points = 10 points per whole dollar.
  log('registering server-side UDF loyalty_points(price)…');
  conn.registerScalarFunction(DuckDBScalarFunction.create({
    name: 'loyalty_points',
    parameterTypes: [DOUBLE],
    returnType: INTEGER,
    mainFunction: (info, input, output) => {
      const prices = input.getColumnVector(0);
      for (let i = 0; i < input.rowCount; i++) {
        output.setItem(i, Math.floor(prices.getItem(i)) * 10);
      }
      output.flush();
    },
  }));

  log(`calling quack_serve('${uri}')…`);
  const reader = await conn.runAndReadAll(`CALL quack_serve('${uri}', token => '${token}')`);
  log(`quack_serve returned: ${JSON.stringify(reader.getRowObjectsJson())}`);

  return {
    instance,
    conn,
    uri,
    token,
    async readBack(sql) { return (await conn.runAndReadAll(sql)).getRowObjectsJson(); },
    async stop() { try { await conn.run(`CALL quack_stop('${uri}')`); } catch {} },
  };
}
