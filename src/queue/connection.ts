import { RedisOptions, Redis } from "ioredis";
import {env} from "../utils/config";

const redisHost =
  env.NODE_ENV === "development"
    ? env.REDIS_DEV_HOST
    : env.REDIS_HOST;

const redisPort = Number(
  env.NODE_ENV === "development"
    ? env.REDIS_DEV_PORT
    : env.REDIS_PORT
);

const redisPassword =
  env.NODE_ENV === "development"
    ? env.REDIS_DEV_PASSWORD
    : env.REDIS_PASSWORD;

    console.log({
      env: env.NODE_ENV,
      redisHost,
      redisPort,
      redisPassword
    })

export const redisConnection: RedisOptions = {
  host: redisHost,
  port: redisPort,
  password: redisPassword,
  username: "default",
  tls: {},
};

export const redis = new Redis(redisConnection);
