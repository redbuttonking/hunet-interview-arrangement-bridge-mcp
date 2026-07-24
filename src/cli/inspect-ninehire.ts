import { getConfig } from "../config.js";
import { NinehireMcpGateway } from "../ninehire/gateway.js";

const config = getConfig();
const gateway = new NinehireMcpGateway(config.ninehire);

try {
  const tools = await gateway.listTools();
  process.stdout.write(`${JSON.stringify({ tools }, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`NineHire inspection failed: ${message}\n`);
  process.exitCode = 1;
}
