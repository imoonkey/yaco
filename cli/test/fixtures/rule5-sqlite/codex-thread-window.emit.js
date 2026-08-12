import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { codexDbPath } from "./provider-home.js";
export function codexThreadWindow(cwd, limit) {
    if (!existsSync(codexDbPath()))
        return [];
    try {
        const db = new DatabaseSync(codexDbPath(), { readOnly: true });
        try {
            return db
                .prepare(`SELECT id, title, first_user_message, created_at, updated_at, git_branch, rollout_path
           FROM threads WHERE (cwd = ? OR substr(cwd, 1, length(?)) = ?) AND archived = 0
           ORDER BY updated_at DESC, id ASC LIMIT ?`)
                .all(cwd, `${cwd}/`, `${cwd}/`, limit);
        }
        finally {
            db.close();
        }
    }
    catch {
        return [];
    }
}
