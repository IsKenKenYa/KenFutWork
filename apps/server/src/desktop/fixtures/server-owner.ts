import { acquireDesktopServerOwner } from "../server-owner.js";

const directory = process.argv[2];
if (!directory) throw new Error("缺少验收目录");
const owner = acquireDesktopServerOwner(directory);
process.on("SIGTERM", () => {
  owner.close();
  process.exit(0);
});
process.stdin.resume();
process.stdout.write("READY\n");
