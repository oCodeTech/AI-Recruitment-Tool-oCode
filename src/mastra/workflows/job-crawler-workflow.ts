import { createStep, createWorkflow } from "@mastra/core";
import z from "zod";

import { redis } from "../../queue/connection";

const jobCrawlTrigger = createStep({
  id: "job-crawl-trigger",
  description: "Triggers the workflow when new job openings are found",
  inputSchema: z.object({ url: z.string() }).describe("Job Opening URL"),
  outputSchema: z.string().nullable().describe("extracted job opening content"),
  execute: async ({ inputData: { url }, mastra }) => {
    if (!url) {
      console.error("No job opening URL found");
      return null;
    }

    try {
      const alreadyProcessed = await redis.get(`processed_job_opening:${url}`);
      if (alreadyProcessed) {
        console.log(`Job opening ${url} already processed, skipping`);
        return null;
      }

      await redis.set(`processed_job_opening:${url}`, "1", "EX", 3600);

      const webCrawlerAgent = mastra.getAgent("webCrawlerAgent");

    const result = await webCrawlerAgent.generate(
  `Please extract the job opening content from the following URL: ${url}`,
  {
    instructions: `
You are an AI agent. Your task is to extract all main content related to a job opening from the provided URL.

Instructions:
1. Use the fetcher_fetch_url tool to fetch the webpage content. Pass the URL as:
   {
     "url": "${url}"
   }
2. Carefully review the fetched content. Only proceed if the page contains a job opening or job description.
3. If the content is related to a job opening, extract and include all main content and sections relevant to the job. This includes, but is not limited to:
   - Job Title
   - Company Name
   - Location
   - Responsibilities
   - Requirements
   - Qualifications
   - Benefits
   - Salary or Compensation
   - About the Company
   - How to Apply
   - Any other relevant information or sections present in the job posting
4. Present all extracted content in a well-structured Markdown (.md) format, preserving the original section headings and order as much as possible.
5. If the page does not contain a job opening or job description, respond with: unrelated
6. Do not include any content that is not directly related to the job opening.

Example input to fetcher_fetch_url:
{
  "url": "${url}"
}

Example output (if relevant):
\`\`\`md
## Senior Backend Developer

**Company:** Example Corp  
**Location:** Remote

**About the Company:**
Example Corp is a leading provider of cloud solutions...

**Responsibilities:**
- Design and implement backend services
- Collaborate with frontend and DevOps teams

**Requirements:**
- 5+ years experience in backend development
- Proficiency in Node.js and TypeScript

**Qualifications:**
- Bachelor’s degree in Computer Science or related field

**Benefits:**
- Health insurance
- Flexible working hours

**Salary:**
$120,000 - $150,000 per year

**How to Apply:**
Send your resume to jobs@example.com
\`\`\`

Example output (if not relevant):
unrelated

Return only the Markdown content or "unrelated".
    `,
    maxSteps: 10,
    maxTokens: 500
  }
);

      const extractedJobOpeningContent = result.text;

      console.log("extractedJobOpeningContent", extractedJobOpeningContent);

      return extractedJobOpeningContent;
    } catch (err) {
      console.log(err);
      return null;
    }
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
}).then(jobCrawlTrigger);

jobCrawlerWorkflow.commit();

export { jobCrawlerWorkflow };
