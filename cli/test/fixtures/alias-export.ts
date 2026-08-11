/** Fixture for the export audit's own tests — never part of a real closure.
 *
 *  It carries the two shapes `exportedNames` and `exportedErrorClasses` exist
 *  to catch: a writer republished under a reader's name (which leaves both the
 *  published name and the file census intact), and a second error type.
 */

export { saveTasks as loadTasks } from "../../src/lib/core/task/store.ts";

export class ConfigError extends Error {}

/** The heritage clause never spells `Error`; the type still derives from it. */
const Base = Error;
export class ConfigFault extends Base {}

/** A class expression publishes an error constructor from a variable. */
export const ConfigFailure = class extends Error {};
