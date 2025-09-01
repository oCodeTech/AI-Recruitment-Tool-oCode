import { RedisOptions, Redis } from "ioredis";

export const redisConnection: RedisOptions = {
  host:
    process.env.NODE_ENV === "development"
      ? process.env.REDIS_DEV_HOST
      : process.env.REDIS_HOST,
  port: Number(
    process.env.NODE_ENV === "development"
      ? process.env.REDIS_DEV_PORT
      : process.env.REDIS_PORT
  ),
  password:
    process.env.NODE_ENV === "development"
      ? process.env.REDIS_DEV_PASSWORD
      : process.env.REDIS_PASSWORD,
  username: "default",
  // tls: {},
};

export const redis = new Redis(redisConnection);
