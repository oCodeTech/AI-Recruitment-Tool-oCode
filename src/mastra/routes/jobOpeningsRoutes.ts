import express from "express";
import {
  createJobOpening,
  deleteJobOpening,
  getJobOpenings,
} from "../controllers/jobOpenings";

const router = express.Router();

router.get("/", getJobOpenings);
router.post("/", createJobOpening);
router.delete("/", deleteJobOpening);

export default router;
/*

working prompt and instructions for context QA for job openings

const result = await ragAgent.generate(
      `Use the rag_query_documents tool to search for open job positions, vacancies, or hiring opportunities.`,
      {
        instructions: `You must use the rag_query_documents tool to find all embedded documents related to open job positions, vacancies, or hiring opportunities.
Query the documents with: "open job positions, vacancies, hiring opportunities"
Retrieve up to 15 relevant documents (k = 15).`,
        maxSteps: 10,
        maxTokens: 1000,
      }
    );
*/

/*
dummy json for testing


{
  "position": "Software Engineer",
  "category": "Technology",
  "type": "Full-time",
  "schedule": "Regular",
  "location": "Remote",
  "salaryRange": "100000-150000",
  "description": "We are looking for a skilled software engineer to join our team. The ideal candidate will have a strong background in computer science and software engineering principles.",
  "keyResponsibilites": [
    "Design, develop, test, deploy, maintain and improve software",
    "Collaborate with cross-functional teams to identify and prioritize project requirements",
    "Troubleshoot and resolve complex technical issues",
    "Develop and maintain technical documentation",
    "Participate in code reviews and contribute to the improvement of the overall code quality"
  ],
  "requirements": [
    "Bachelor's degree in Computer Science or related field",
    "5+ years of experience in software development",
    "Experience with distributed systems, cloud computing and containerization",
    "Strong understanding of computer science fundamentals (data structures, algorithms, software design patterns)",
    "Experience with Agile development methodologies",
    "Strong communication and collaboration skills",
    "Experience with AWS or Google Cloud"
  ],
  "qualifications": [
    "Experience with Kubernetes",
    "Experience with serverless computing",
    "Experience with CI/CD pipelines",
    "Strong understanding of security best practices",
    "Experience with containerization using Docker"
  ],
  "experienceRequired": "5-10"
}
*/
