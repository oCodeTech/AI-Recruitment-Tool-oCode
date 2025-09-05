import { UpstashVector } from "@mastra/upstash";
import { PgVector } from "@mastra/pg";
import { env } from "../utils/config";

function getVectorStore(): UpstashVector | PgVector {
  const enviroment = env.NODE_ENV || "development";

  try{
    if (
      enviroment === "development" &&
      env.VECTOR_UPSTASH_URL &&
      env.VECTOR_UPSTASH_TOKEN
    ) {
        console.log({
      enviroment,
      VECTOR_UPSTASH_URL: env.VECTOR_UPSTASH_URL,
      VECTOR_UPSTASH_TOKEN: env.VECTOR_UPSTASH_TOKEN
    })
      return new UpstashVector({
        url: env.VECTOR_UPSTASH_URL!,
        token: env.VECTOR_UPSTASH_TOKEN!,
      });
    } else if (
      enviroment === "production" &&
      env.POSTGRES_VECTOR_CONNECTION_STRING
  ) {
            console.log({
      enviroment,
      POSTGRES_VECTOR_CONNECTION_STRING: env.POSTGRES_VECTOR_CONNECTION_STRING
      
    })
    return new PgVector({
      connectionString: env.POSTGRES_VECTOR_CONNECTION_STRING,
    });
  }
}catch(e){
  console.log("error occured while creating vector store",e);
}

  throw new Error(
    "Vector store not configured, please set VECTOR_UPSTASH_URL and VECTOR_UPSTASH_TOKEN or POSTGRES_VECOTR_CONNECTION_STRING"
  );
}

export const vectorStore = getVectorStore();
