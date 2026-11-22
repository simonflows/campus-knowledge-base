// CI only. The fixed upstream is the in-memory database on the Compose network.
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { createServer } from "node:tls";

const server = createServer(
  {
    key: readFileSync("/run/qa-tls.key"),
    cert: readFileSync("/run/qa-tls.crt"),
    minVersion: "TLSv1.2",
  },
  (client) => {
    const database = connect({ host: "database", port: 8000 });
    const close = () => {
      client.destroy();
      database.destroy();
    };
    database.on("error", close).on("close", close);
    client.on("error", close).on("close", close);
    client.setTimeout(30_000, close);
    client.pipe(database).pipe(client);
  }
);

server.listen(8443, "0.0.0.0");
