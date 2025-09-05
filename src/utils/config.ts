import dotenv from "dotenv";
import path from "path";

const dirname = path.dirname(new URL(import.meta.url).pathname);

dotenv.config({
  path: path.resolve(dirname, "../../.env"),
});

export const env = process.env;