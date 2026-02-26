import { parseArgs } from "node:util";
import { createServer } from "./web-server.js";

function parseBootstrap(value: string | undefined): { host: string; port: number }[] | undefined {
  if (!value) return undefined;
  return value.split(",").map((addr) => {
    const [host, portStr] = addr.trim().split(":");
    return { host, port: Number.parseInt(portStr, 10) };
  });
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    folder: { type: "string" },
    port: { type: "string" },
    bootstrap: { type: "string" },
  },
  strict: false,
});

const portStr = typeof values.port === "string" ? values.port : undefined;
const port = portStr ? Number.parseInt(portStr, 10) : 3000;
const folderArg = typeof values.folder === "string" ? values.folder : undefined;
const bootstrapArg = typeof values.bootstrap === "string" ? values.bootstrap : undefined;
const bootstrap = parseBootstrap(bootstrapArg);

const server = await createServer({ folder: folderArg, bootstrap });
const actualPort = await server.listen(port);

console.log(`PearSync running at http://localhost:${actualPort}`);
if (bootstrap) {
  console.log(`Using bootstrap: ${bootstrapArg}`);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log(`\n${sig} received, shutting down...`);
    await server.close();
    process.exit(0);
  });
}
