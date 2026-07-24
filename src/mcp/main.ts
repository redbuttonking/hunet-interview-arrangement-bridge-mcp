import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getConfig } from "../config.js";
import { BridgeDatabase } from "../db/database.js";
import { createBridgeMcpServer } from "./server.js";

const config = getConfig();
const db = new BridgeDatabase(config.dbPath);
const server = createBridgeMcpServer(config, db);
const transport = new StdioServerTransport();

process.once("SIGINT", () => {
  db.close();
  process.exit(0);
});
process.once("SIGTERM", () => {
  db.close();
  process.exit(0);
});

await server.connect(transport);
