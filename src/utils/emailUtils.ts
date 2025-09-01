import { extractText } from "unpdf";
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
        // Clean up any parenthetical information
        jobTitle = jobTitle.replace(/\s*\(.*?\)$/, "").trim();
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
      /^(?:Re:\s*)?New application received for the position of (.+?)(?:\s+at\s+|$)/i,
      /^(?:Re:\s*)?Job Application\s+\|\s*(.+?)\s*\|/i,
      // Add pattern for "Application for [Position] Position" format
      /^(?:Re:\s*)?Application for (.+?) Position/i,
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
      /•\s*position\s+applied\s+for:\s*([^•\n]+)/i,
      // Asterisk format
      /\*Position\s+Applied\s+For\*:\s*([^*\n]+)/i,
      // Dash format
      /-\s*Position\s+applied\s+for:\s*([^-]+)/i,
      // Simple format - stop at next field or end of line
      /position\s*[:.]\s*([^•\n*]*(?=(?:\s*[•*]|\s*\d+\.|\s*[A-Z][a-z]+\s*[:.]|-|$)))/i,
      // Numbered list format
      /(?:^|\s)\d+\.\s*Position\s*[:.-]?\s*([^\d\n]+)/i,
    ]);
  }

  /* ---------- 2. Current CTC extraction ---------- */
  const currentCTC = extractField([
    // Numbered list format (like "1. Current CTC - 24k")
    /(?:^|\s)\d+\.\s*Current\s+CTC\s*[-.:]?\s*([^\d\n]+?)(?=\s*\d+\.|$)/i,
    // Bullet point format
    /•\s*current\s+ctc[^:]*:\s*([^•\n]+?)(?=•|$)/i,
    // Asterisk format
    /\*Current\s+CTC\*:\s*([^*\n]+?)(?=\*|$)/i,
    // Dash format
    /-\s*Current\s+CTC:\s*([^-\n]+?)(?=-|$)/i,
    // Simple format - stop at next field
    /current\s+ctc\s*[:.]\s*([^•\n*]+?)(?=(?:\s*[•*]|\s*\d+\.|\s*[A-Z][a-z]+\s*[:.]|-|$))/i,
  ]);

  /* ---------- 3. Expected CTC extraction ---------- */
  const expectedCTC = extractField([
    // Numbered list format (like "2. Expected CTC - 30k")
    /(?:^|\s)\d+\.\s*Expected\s+CTC\s*[-.:]?\s*([^\d\n]+?)(?=\s*\d+\.|$)/i,
    // Bullet point format
    /•\s*expected\s+ctc:\s*([^•\n]+?)(?=•|$)/i,
    // Asterisk format
    /\*Expected\s+CTC\*:\s*([^*\n]+?)(?=\*|$)/i,
    // Dash format
    /-\s*Expected\s+CTC:\s*([^-\n]+?)(?=-|$)/i,
    // Simple format - stop at next field
    /expected\s+ctc\s*[:.]\s*([^•\n*]+?)(?=(?:\s*[•*]|\s*\d+\.|\s*[A-Z][a-z]+\s*[:.]|-|$))/i,
  ]);

  /* ---------- 4. Work Experience extraction ---------- */
  const workExp = extractField([
    // Numbered list format (like "5. Total relevant work experience - 2 year 6 months")
    /(?:^|\s)\d+\.\s*Total\s+(?:relevant\s+)?work\s+experience\s*[-.:]?\s*([^\d\n]+?)(?=\s*\d+\.|$)/i,
    // Bullet point format
    /•\s*total\s+(?:relevant\s+)?work\s+experience:\s*([^•\n]+?)(?=•|$)/i,
    // Asterisk format
    /\*Total\s+Relevant\s+Work\s+Experience\*:\s*([^*\n]+?)(?=\*|$)/i,
    // Dash format
    /-\s*Total\s+relevant\s+work\s+experience:\s*([^-\n]+?)(?=-|$)/i,
    // Simple format - stop at next field
    /total\s+(?:relevant\s+)?work\s+experience\s*[:.]\s*([^•\n*]+?)(?=(?:\s*[•*]|\s*\d+\.|\s*[A-Z][a-z]+\s*[:.]|-|$))/i,
    // Handle "Total Experience" format
    /total\s+experience\s*[:.]\s*([^•\n*]+?)(?=(?:\s*[•*]|\s*\d+\.|\s*[A-Z][a-z]+\s*[:.]|-|$))/i,
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

export async function extractTextFromPDF(pdfBuffer: Buffer): Promise<string> {
  try {
    const { text } = await extractText(new Uint8Array(pdfBuffer));

    return text[0];
  } catch (err) {
    console.error("Error extracting text from PDF", err);
    throw "";
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
  webUrl,
}: {
  filename?: string;
  attachment?: string;
  webUrl?: string;
}): Promise<string> {
  if (filename && attachment) {
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
      return "";
    }
  } else if (webUrl) {
    try {
      const response = await fetch(webUrl, {
        method: "GET",
        headers: {
          "Content-Type": "application/pdf",
        },
      });

      if (!response.ok) throw Error("Failed to fetch resume");
      const pdfBuffer = await response.arrayBuffer();
      const { text } = await extractText(pdfBuffer);

      return text[0];
    } catch (err) {
      console.log(err);
      return "";
    }
  } else {
    return "";
  }
}

export async function extractResumeText(resumeLink: string) {
  if (!resumeLink) return "";

  try {
    const response = await fetch(resumeLink, {
      method: "GET",
      headers: {
        "Content-Type": "text/html",
      },
    });
    if (!response.ok) throw Error("Failed to fetch resume");

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const result = await reader?.read();
      if (!result) break; // or throw an error, depending on your use case
      const { value, done } = result;
      if (done) break;
      text += decoder.decode(value);
    }

    console.log("text", text);

    return text;
    // const pdfBuffer = await response.arrayBuffer();
    // const { text } = await extractText(pdfBuffer);
    // return text[0];
  } catch (err) {
    console.log(err);
    return "";
  }
}
