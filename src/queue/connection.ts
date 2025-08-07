import { RedisOptions, Redis } from "ioredis";

export const redisConnection: RedisOptions = {
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT),
  password: process.env.REDIS_PASSWORD,
  username: "default",
  tls: {},
};

export const redis = new Redis(redisConnection);
