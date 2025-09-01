import { UpstashVector } from "@mastra/upstash";
import { PgVector } from "@mastra/pg";

function getVectorStore(): UpstashVector | PgVector {
  const enviroment = process.env.NODE_ENV || "development";

  try{
    if (
      enviroment === "development" &&
      process.env.VECTOR_UPSTASH_URL &&
      process.env.VECTOR_UPSTASH_TOKEN
    ) {
      return new UpstashVector({
        url: process.env.VECTOR_UPSTASH_URL!,
        token: process.env.VECTOR_UPSTASH_TOKEN!,
      });
    } else if (
      enviroment === "production" &&
      process.env.POSTGRES_VECTOR_CONNECTION_STRING
  ) {
    return new PgVector({
      connectionString: process.env.POSTGRES_VECTOR_CONNECTION_STRING,
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
