import { RedisOptions, Redis } from "ioredis";

const redisHost =
  process.env.NODE_ENV === "development"
    ? process.env.REDIS_DEV_HOST
    : process.env.REDIS_HOST;

const redisPort = Number(
  process.env.NODE_ENV === "development"
    ? process.env.REDIS_DEV_PORT
    : process.env.REDIS_PORT
);

const redisPassword =
  process.env.NODE_ENV === "development"
    ? process.env.REDIS_DEV_PASSWORD
    : process.env.REDIS_PASSWORD;

export const redisConnection: RedisOptions = {
  host: redisHost,
  port: redisPort,
  password: redisPassword,
  username: "default",
  tls: {},
};

export const redis = new Redis(redisConnection);
