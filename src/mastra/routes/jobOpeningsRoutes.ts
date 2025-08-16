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

[
  {
    "position": "AI/ML Engineer",
    "category": "Technology",
    "type": "Full-time",
    "schedule": "Regular",
    "location": "Remote",
    "salaryRange": "110000-160000",
    "description": "We are seeking an AI/ML Engineer to design and implement machine learning models that drive business solutions. The role requires a strong understanding of machine learning algorithms and frameworks.",
    "keyResponsibilities": [
      "Develop and deploy machine learning models",
      "Work with large datasets to derive insights",
      "Collaborate with data scientists and engineers to integrate models into applications",
      "Continuously improve model performance and accuracy",
      "Stay updated with the latest developments in AI and ML"
    ],
    "requirements": [
      "Master's degree in Computer Science, AI, or related field",
      "3+ years of experience in machine learning or data science",
      "Proficiency with ML frameworks (TensorFlow, PyTorch)",
      "Experience with data processing and analysis tools (Pandas, NumPy)",
      "Strong programming skills in Python"
    ],
    "qualifications": [
      "Experience with cloud-based ML platforms (AWS SageMaker, Google AI Platform)",
      "Knowledge of deep learning techniques",
      "Experience with natural language processing (NLP)",
      "Strong mathematical and statistical skills"
    ],
    "experienceRequired": "3-8"
  }
]
*/
