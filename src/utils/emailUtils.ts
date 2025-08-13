import { PdfReader } from "pdfreader";
import mammoth from "mammoth";

type FastParseResult = {
  job_title: string;
  experience_status: "experienced" | "fresher" | "unclear";
  category: string;
} | null;

export function fastParseEmail(subject: string, body: string): FastParseResult {
  const text = (subject + " " + body)
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  let jobTitle: string | null = null;

  if (subject) {
    const subjectPatterns = [
      /^Application for (.+?)(?:\s*\(|\s+Role|\s+Position|$)/i,
      /^New application received for the position of (.+?)(?:\s*\[|\s+at|$)/i,
      /^Job Opening: (.+?)(?:\s*\[|\s+at|$)/i,
      /^Applying for the (.+?)(?:\s+Role|\s+Position|$)/i,
      /^I'm interested in (.+?)(?:\s+Role|\s+Position|$)/i,
      /^Applying for the post of (.+)$/i,
      /^Application for (.+)$/i,
    ];

    for (const pattern of subjectPatterns) {
      const match = subject.match(pattern);
      if (match) {
        jobTitle = match[1].trim();
        break;
      }
    }

    if (jobTitle && (jobTitle.includes("|") || jobTitle.includes("/"))) {
      const parts = jobTitle.split(/[|/]/);
      jobTitle = parts[parts.length - 1].trim();
    }

    if (jobTitle) {
      jobTitle = jobTitle
        .replace(/^post of\s+/i, "")
        .replace(/^position of\s+/i, "")
        .replace(/^frontend\s+/i, "")
        .replace(/\s+Position$/i, "")
        .replace(/\s+Role$/i, "")
        .replace(/\s+at\s+.+$/i, "")
        .replace(/\s*\[.+\]$/, "")
        .trim();
    }
  }

  if (!jobTitle && body) {
    const bodyPatterns = [
      /(?:I am writing to express my interest in|I am applying for|interest in) the (.+?)(?:\s+Role|\s+Position|$)/i,
      /(?:position|role) of (.+?)(?:\s+at|\s*\[|$)/i,
      /Job Opening: (.+?)(?:\s*\[|\s+at|$)/i,
    ];

    for (const pattern of bodyPatterns) {
      const match = body.match(pattern);
      if (match) {
        jobTitle = match[1].trim();
        break;
      }
    }
  }

  if (!jobTitle) {
    const jobTitlePhrases = [
      "as a (.+?)(?:\s+at|\s+for|\s+with|$)",
      "as an? (.+?)(?:\s+at|\s+for|\s+with|$)",
      "position of (.+?)(?:\s+at|\s+for|\s+with|$)",
    ];

    for (const phrase of jobTitlePhrases) {
      const pattern = new RegExp(phrase, "i");
      const match = text.match(pattern);
      if (match) {
        jobTitle = match[1].trim();
        break;
      }
    }
  }

  if (!jobTitle) {
    const roleKeywords = [
      "developer",
      "engineer",
      "programmer",
      "designer",
      "manager",
      "consultant",
      "analyst",
      "specialist",
    ];

    for (const keyword of roleKeywords) {
      const regex = new RegExp(`(\\w+\\s+${keyword})`, "gi");
      let match;
      while ((match = regex.exec(text)) !== null) {
        jobTitle = match[1].trim();
      }
      if (jobTitle) break;
    }
  }

  if (!jobTitle) return null;

  let expStatus: "experienced" | "fresher" | "unclear" = "unclear";

  const experiencePatterns = [
    /\b\d+(?:\.\d+)?\s*(?:\+?\s*years?|yrs?)\b/i,
    /\bwith\s+\d+(?:\.\d+)?\s*\+?\s*years?\s+of\s+experience\b/i,
    /\bover\s+\d+(?:\.\d+)?\s*years?\b/i,
    /\bbuilt\s+\d+\s+apps?\b/i,
    /\bthroughout\s+my\s+career\b/i,
    /\benhanced\s+\w+\s+performance\b/i,
    /\bmigrating\s+to\s+\w+\s+components\b/i,
    /\bworked\s+as\s+a\s+\w+\s+(?:developer|engineer)\b/i,
    /\bexperience\s+in\s+\w+\s+development\b/i,
  ];

  const fresherPatterns = [
    /\brecent\s+graduate\b/i,
    /\bfresher\b/i,
    /\bintern\b/i,
    /\bentry.?level\b/i,
    /\btraining\s+in\b/i,
    /\bcompleted\s+\w+\s+training\b/i,
  ];

  if (experiencePatterns.some((pattern) => pattern.test(text))) {
    expStatus = "experienced";
  } else if (fresherPatterns.some((pattern) => pattern.test(text))) {
    expStatus = "fresher";
  }

  let category = "unclear";

  const jobTitleLower = jobTitle.toLowerCase();

  const categoryKeywords = {
    Recruiter: ["recruiter", "hr", "talent acquisition", "it recruitment"],
    Developer: [
      "developer",
      "engineer",
      "programmer",
      "flutter",
      "react",
      "react js",
      "backend",
      "frontend",
      "full.stack",
      "node",
      "laravel",
      "php",
      "mobile",
      "app",
      "software",
      "javascript",
      "js",
      "python",
      "devops",
    ],
    "Web Designer": ["designer", "ui/ux", "web design"],
    "Sales/Marketing": ["sales", "marketing", "business development"],
  };

  for (const [cat, keywords] of Object.entries(categoryKeywords)) {
    if (keywords.some((k) => jobTitleLower.includes(k))) {
      category = cat;
      break;
    }
  }

  if (category === "unclear") {
    for (const [cat, keywords] of Object.entries(categoryKeywords)) {
      if (keywords.some((k) => text.includes(k))) {
        category = cat;
        break;
      }
    }
  }

  return {
    job_title: jobTitle.trim(),
    experience_status: expStatus,
    category,
  };
}

interface DetailedCandidateInfo {
  position: string;
  currentCTC: string;
  expectedCTC: string;
  workExp: string;
}

type DetailedParseResult = DetailedCandidateInfo | null;

export function extractDetailedCandidateInfo(
  subject: string,
  body: string,
  attachmentContent?: string
): DetailedParseResult {
  // Normalize text by replacing newlines with spaces and normalize bullet points
  const text = (subject + " " + body + " " + (attachmentContent || ""))
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Helper function to extract field value with multiple patterns
  const extractField = (
    patterns: RegExp[],
    defaultValue = "unclear"
  ): string => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const value = match[1].trim();
        // Return defaultValue if empty string
        return value === "" ? defaultValue : value;
      }
    }
    return defaultValue;
  };

  /* ---------- 1. Position extraction ---------- */
  let position: string = "unclear";

  // Try to extract from subject first
  if (subject) {
    const subjectPatterns = [
      /^(?:Re:\s*)?New application received for the position of (.+?)(?:\s+at\s+)/i,
      /^(?:Re:\s*)?Job Application\s+\|\s*(.+?)\s*\|/i,
    ];

    for (const pattern of subjectPatterns) {
      const match = subject.match(pattern);
      if (match) {
        position = match[1].trim();
        // Clean up any parenthetical information
        position = position.replace(/\s*\(.*?\)$/, "").trim();
        break;
      }
    }
  }

  // If subject didn't yield a position, try body
  if (position === "unclear") {
    position = extractField([
      // Bullet point format
      /•\s*position\s+applied\s+for:\s*([^•]+)/i,
      // Asterisk format
      /\*Position\s+Applied\s+For\*:\s*([^*]+)/i,
      // Simple format
      /position\s*[:.]\s*([^•\n*]+)/i,
    ]);
  }

  /* ---------- 2. Current CTC extraction ---------- */
  const currentCTC = extractField([
    // Bullet point format
    /•\s*current\s+ctc[^:]*:\s*([^•]+)/i,
    // Asterisk format
    /\*Current\s+CTC\*:\s*([^*]+)/i,
    // Simple format
    /current\s+ctc\s*[:.]\s*([^•\n*]+)/i,
  ]);

  /* ---------- 3. Expected CTC extraction ---------- */
  const expectedCTC = extractField([
    // Bullet point format
    /•\s*expected\s+ctc:\s*([^•]+)/i,
    // Asterisk format
    /\*Expected\s+CTC\*:\s*([^*]+)/i,
    // Simple format
    /expected\s+ctc\s*[:.]\s*([^•\n*]+)/i,
  ]);

  /* ---------- 4. Work Experience extraction ---------- */
  const workExp = extractField([
    // Bullet point format
    /•\s*total\s+(?:relevant\s+)?work\s+experience:\s*([^•]+)/i,
    // Asterisk format
    /\*Total\s+Relevant\s+Work\s+Experience\*:\s*([^*]+)/i,
    // Simple format
    /total\s+experience\s*[:.]\s*([^•\n*]+)/i,
  ]);

  // Create result object with only the required fields
  const result: DetailedCandidateInfo = {
    position,
    currentCTC,
    expectedCTC,
    workExp,
  };

  return result;
}

function formatResumeContent(text: string): string {
  // Step 1: Remove all spaces between individual characters
  let cleaned = text.replace(/(\S)\s(?=\S)/g, '$1');
  
  // Step 2: Fix punctuation spacing
  cleaned = cleaned.replace(/\s+([.,;:!?)])/g, '$1');
  cleaned = cleaned.replace(/([(])\s+/g, '$1');
  
  // Step 3: Add spaces after punctuation where needed
  cleaned = cleaned.replace(/([.,;:!?])(?=[A-Z])/g, '$1 ');
  
  // Step 4: Add line breaks before all-caps section headers
  cleaned = cleaned.replace(/([a-z.])([A-Z]{2,}(?:\s+[A-Z]{2,})*)/g, '$1\n\n$2');
  
  // Step 5: Add line breaks after dates
  cleaned = cleaned.replace(/([A-Z][a-z]{2,} \d{4} - [A-Z][a-z]{2,} \d{4})(?=[A-Z])/g, '$1\n');
  cleaned = cleaned.replace(/([A-Z][a-z]{2,} \d{4})(?=[A-Z])/g, '$1\n');
  
  // Step 6: Add line breaks after contact information
  cleaned = cleaned.replace(/([\w.-]+@[\w.-]+\.\w+)(?=[A-Z])/g, '$1\n');
  cleaned = cleaned.replace(/(\+\d{1,3}[-\s]?\d{10})(?=[A-Z])/g, '$1\n');
  
  // Step 7: Add line breaks after project titles
  cleaned = cleaned.replace(/(\d{2,}\s*[A-Z]{2,}:)/g, '\n$1');
  
  // Step 8: Add line breaks after colons in section headers
  cleaned = cleaned.replace(/(Languages|Awards|Activities|Programming|Database|Version|Web|Technologies|Achievement|Stream|Board|Key)(:)/gi, '$1$2\n');
  
  // Step 9: Clean up excessive line breaks
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  
  // Step 10: Add proper spacing after colons
  cleaned = cleaned.replace(/:(?=[^\s])/g, ': ');
  
  // Step 11: Fix common capitalization issues
  cleaned = cleaned.replace(/\b(b\.tech|c\+\+|sql|html|css|js|php|mysql|git|github|react\.js|spring boot)\b/gi, match => match.toUpperCase());
  
  // Step 12: Fix specific words that were incorrectly joined
  cleaned = cleaned.replace(/Greenfield/g, 'Green field');
  cleaned = cleaned.replace(/MySQL/g, 'My SQL');
  cleaned = cleaned.replace(/SpringBoot/g, 'Spring Boot');
  
  // Step 13: Add line breaks before and after name (all caps followed by comma)
  cleaned = cleaned.replace(/([A-Z]{2,} [A-Z]{2,},)/g, '\n$1\n');
  
  // Step 14: Fix contact info line
  cleaned = cleaned.replace(/(\d+, .+?) \|/g, '$1\n|');
  
  return cleaned.trim();
}


export async function extractTextFromPDF(pdfBuffer: Buffer): Promise<string> {
  try {
    let text = "";
    return new Promise((resolve, reject) => {
      new PdfReader().parseBuffer(pdfBuffer, (err, item) => {
        if (err) reject(err);
        else if (!item) resolve(formatResumeContent(text));
        else if (item.text) text += item.text + " ";
      });
    });
  } catch (err) {
    console.error("Error extracting text from PDF", err);
    throw err;
  }
}

export async function extractTextFromDOCX(buffer: Buffer): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } catch (err) {
    console.error("Error extracting text from DOCX", err);
    throw err;
  }
}

export async function extractTextFromAttachment({
  filename,
  attachment,
}: {
  filename: string;
  attachment: string;
}): Promise<string> {
  const base64String = attachment.replace(/-/g, "+").replace(/_/g, "/");
  const buffer = Buffer.from(
    base64String + "=".repeat((4 - (base64String.length % 4)) % 4),
    "base64"
  );

  if (filename.includes(".pdf")) {
    return await extractTextFromPDF(buffer);
  } else if (filename.includes(".doc") || filename.includes(".docx")) {
    return await extractTextFromDOCX(buffer);
  } else {
    console.log("Unable to parse resume, skipping this mail");
    return "";
  }
}
