import { openDatabase } from "../storage/database.js";
import { HistoricalReplayEngine } from "../observation/historical-replay-engine.js";

const databasePath = process.env.STELLAR_DATABASE_PATH;
if (!databasePath) {
  throw new Error("STELLAR_DATABASE_PATH must be configured before running historical replay");
}

const database = openDatabase(databasePath);
try {
  const replay = new HistoricalReplayEngine(database);
  console.log(JSON.stringify(replay.run(), null, 2));
} finally {
  database.close();
}
