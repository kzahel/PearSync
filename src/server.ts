import { parseArgs } from "node:util";
import { createServer } from "./web-server.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    folder: { type: "string" },
    port: { type: "string" },
  },
  strict: false,
});

const portStr = typeof values.port === "string" ? values.port : undefined;
const port = portStr ? Number.parseInt(portStr, 10) : 3000;
const folderArg = typeof values.folder === "string" ? values.folder : undefined;
const server = await createServer({ folder: folderArg });
const actualPort = await server.listen(port);

console.log(`PearSync running at http://localhost:${actualPort}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log(`\n${sig} received, shutting down...`);
    await server.close();
    process.exit(0);
  });
}
