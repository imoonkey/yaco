import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { codexDbPath } from "./provider-home.ts";
export function codexThreadRow(sessionId) {
    if (!existsSync(codexDbPath()))
        return null;
    try {
        const db = new DatabaseSync(codexDbPath(), { readOnly: true });
        try {
            const row = db
                .prepare("SELECT title, first_user_message FROM threads WHERE id = ?")
                .get(sessionId);
            return row ? { title: row.title ?? null, first: row.first_user_message ?? null } : null;
        }
        finally {
            db.close();
        }
    }
    catch {
        return null;
    }
}
