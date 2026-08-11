#!/usr/bin/env node
/** The `yaco` executable: a version guard in front of the command bundle.
 *
 *  Everything the CLI does lives in `../dist/yaco.mjs`. This file exists only
 *  so the floor check runs *before* that bundle is parsed — the bundle targets
 *  Node 24 and uses `node:sqlite`, so on an older Node it fails with a syntax
 *  or missing-builtin error instead of saying which Node it wants. A static
 *  import would hoist and defeat that; the dynamic one is the guard. The
 *  comparator's own import is static and safe: `./node-floor.mjs` has no
 *  dependencies and no syntax an old Node cannot parse.
 *
 *  Exit 3 is the CLI's own ENV code (`lib/core/errors.ts#exitCodeFor`), spelled
 *  literally because this file must stay this small.
 */
import { MINIMUM_NODE, belowNodeFloor } from "./node-floor.mjs";

if (belowNodeFloor(process.versions.node)) {
  process.stderr.write(
    `yaco requires Node >=${MINIMUM_NODE}, found ${process.versions.node}\n`,
  );
  process.exit(3);
}

const { main } = await import("../dist/yaco.mjs");
await main();
