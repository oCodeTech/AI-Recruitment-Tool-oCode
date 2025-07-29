import { createStep, createWorkflow } from "@mastra/core";
import z from "zod";
import { redis } from "../../queue/connection";
import puppeteer from "puppeteer";

import * as fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const JobOpeningSchema = z
  .object({
    title: z.string(),
    category: z.string(),
    type: z.string(),
    location: z.string(),
    salary: z.string(),
    description: z.string(),
    keyResponsibiliites: z.array(
      z
        .object({
          responsibility: z.string(),
          detail: z.string(),
        })
        .nullable()
    ),
    requirements: z.array(
      z
        .object({
          requirement: z.string(),
          detail: z.string(),
        })
        .nullable()
    ),
    experience: z.string(),
  })
  .nullable();

const jobCrawlTrigger = createStep({
  id: "job-crawl-trigger",
  description: "Triggers the workflow when new job openings are found",
  inputSchema: z
    .object({
      url: z.string(),
    })
    .describe("Job Opening details"),
  outputSchema: z
    .object({
      hostname: z.string().describe("Job Opening hostname"),
      url: z.string().describe("Job Opening URL"),
    })
    .nullable(),
  execute: async ({ inputData: { url } }) => {
    if (!url) {
      console.error("No job opening URL found");
      return null;
    }

    try {
      // const alreadyProcessed = await redis.get(`processed_job_opening:${url}`);
      // if (alreadyProcessed) {
      //   console.log(`Job opening ${url} already processed, skipping`);
      //   return null;
      // }

      // await redis.set(`processed_job_opening:${url}`, "1", "EX", 3600);

      const jobOpeningUrl = new URL(url);

      if (!jobOpeningUrl.hostname) return null;

      return {
        url,
        hostname: jobOpeningUrl.hostname,
      };
    } catch (err) {
      console.log(err);
      return null;
    }
  },
});

const handleWebCrawler = createStep({
  id: "handle-web-crawler",
  description: "Handles the web crawler",
  inputSchema: z
    .object({
      hostname: z.string().describe("Job Opening hostname"),
      url: z.string().describe("Job Opening URL"),
    })
    .nullable(),
  outputSchema: JobOpeningSchema,
  execute: async ({ inputData }) => {
    if (!inputData || !inputData.url) return null;

    const url = inputData.url;

    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage();

    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 0 });
      await page.waitForSelector(".awsm-job-container", { timeout: 30000 });

      const jobData = await page.evaluate(() => {
        const title =
          document
            .querySelector(".awsm-jobs-single-title")
            ?.textContent?.trim() || "";
        const category =
          document
            .querySelector(
              ".awsm-job-specification-job-category .awsm-job-specification-term"
            )
            ?.textContent?.trim() || "";
        const type =
          document
            .querySelector(
              ".awsm-job-specification-job-type .awsm-job-specification-term"
            )
            ?.textContent?.trim() || "";
        const location =
          document
            .querySelector(
              ".awsm-job-specification-job-location .awsm-job-specification-term"
            )
            ?.textContent?.trim() || "";

        const salaryElements = document.querySelectorAll(
          ".awsm-job-specification-salary .awsm-job-specification-term"
        );
        const salary =
          Array.from(salaryElements)
            .map((element) => element.textContent?.trim() || "")
            .join(", ") || "";

        const description =
          Array.from(
            document.querySelectorAll(".awsm-job-entry-content p")
          )[0]?.textContent?.trim() || "";

        const keyResponsibiliites =
          Array.from(document.querySelectorAll(".awsm-job-entry-content ul"))[0]
            ?.textContent?.trim()
            .split("\n")
            .map((item) => {
              const [key, value] = item.split(":");

              return { responsibility: key.trim(), detail: value.trim() };
            }) || [];

        const requirements =
          Array.from(document.querySelectorAll(".awsm-job-entry-content ul"))[1]
            ?.textContent?.trim()
            .split("\n")
            .map((item) => {
              const [key, value] = item.split(":");

              return { requirement: key.trim(), detail: value.trim() };
            }) || [];

        const experienceLi = Array.from(
          document.querySelectorAll(".awsm-job-entry-content ul li")
        ).find(
          (li) => li.textContent && li.textContent.includes("Total work:")
        );

        const experience =
          experienceLi && experienceLi.textContent
            ? experienceLi.textContent.trim()
            : "";

        return {
          title,
          category,
          type,
          location,
          salary,
          description,
          keyResponsibiliites,
          requirements,
          experience,
        };
      });

      return jobData;
    } catch (error) {
      console.error("Error crawling:", error);
      return null;
    } finally {
      await browser.close();
    }
  },
});

const indexJobOpening = createStep({
  id: "index-job-opening",
  description: "Indexes the job opening",
  inputSchema: JobOpeningSchema,
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  execute: async ({ inputData, mastra }) => {
    if (!inputData) {
      console.log("No input data found for indexJobOpening step");
      return "No input data found";
    }
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const jobOpeningsDir = path.resolve(
      __dirname,
      "../../src/mastra/job-openings"
    );
    const filePath = path.join(jobOpeningsDir, `jobOpening.json-${Date.now()}`);

    try {
      if (!fs.existsSync(jobOpeningsDir)) {
        fs.mkdirSync(jobOpeningsDir);
      }

      fs.writeFileSync(filePath, JSON.stringify(inputData));

      const ragAgent = mastra?.getAgent("ragAgent");

      if (!ragAgent) throw Error("RAG agent not found");
    } catch (error) {
      console.error("Error occured while indexing the job opening:", error);
    }

    return "";
  },
});

const jobCrawlerWorkflow = createWorkflow({
  id: "job-crawler-workflow",
  description:
    "Workflow to handle job descriptions scraping and document embedding to the index",
  inputSchema: z.object({ url: z.string() }).describe("Job Opening URL"),
  outputSchema: z.string().describe("Final output of the recruitment workflow"),
  steps: [jobCrawlTrigger],
  retryConfig: {
    attempts: 5,
    delay: 5000,
  },
})
  .then(jobCrawlTrigger)
  .then(handleWebCrawler)
  .then(indexJobOpening);

jobCrawlerWorkflow.commit();

export { jobCrawlerWorkflow };
