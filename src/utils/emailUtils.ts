type FastParseResult = {
  job_title: string;
  experience_status: "experienced" | "fresher" | "unclear";
  category: string;
} | null;

export function fastParseEmail(subject: string, body: string): FastParseResult {
  // Normalize text by replacing newlines and extra spaces
  const text = (subject + " " + body)
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  /* ---------- 1. Job title extraction ---------- */
  let jobTitle: string | null = null;

  // Try subject line first (most reliable source)
  if (subject) {
    // Subject-specific patterns
    const subjectPatterns = [
      /^Application for (.+?)(?:\s*\(|\s+Role|\s+Position|$)/i,
      /^New application received for the position of (.+?)(?:\s*\[|\s+at|$)/i,
      /^Job Opening: (.+?)(?:\s*\[|\s+at|$)/i,
      /^Applying for the (.+?)(?:\s+Role|\s+Position|$)/i,
      /^I'm interested in (.+?)(?:\s+Role|\s+Position|$)/i,
      /^Applying for the post of (.+)$/i, // Pattern for this specific case
      /^Application for (.+)$/i, // Fallback for simple subjects
    ];

    for (const pattern of subjectPatterns) {
      const match = subject.match(pattern);
      if (match) {
        jobTitle = match[1].trim();
        break;
      }
    }

    // Handle special separators in subject
    if (jobTitle && (jobTitle.includes("|") || jobTitle.includes("/"))) {
      // Split by separators and take the most specific part (usually last)
      const parts = jobTitle.split(/[|/]/);
      jobTitle = parts[parts.length - 1].trim();
    }

    // Clean up common prefixes and suffixes
    if (jobTitle) {
      jobTitle = jobTitle
        .replace(/^post of\s+/i, "") // Remove "post of" prefix
        .replace(/^position of\s+/i, "") // Remove "position of" prefix
        .replace(/^frontend\s+/i, "") // Remove "Frontend" prefix if present
        .replace(/\s+Position$/i, "") // Remove "Position" suffix
        .replace(/\s+Role$/i, "") // Remove "Role" suffix
        .replace(/\s+at\s+.+$/i, "") // Remove company name
        .replace(/\s*\[.+\]$/, "") // Remove bracketed IDs
        .trim();
    }
  }

  // If subject didn't yield a title, try body
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

  // Fallback: Look for explicit job title mentions
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

  // Ultra fallback: Extract last occurrence of role keywords
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

  /* ---------- 2. Experience status ---------- */
  let expStatus: "experienced" | "fresher" | "unclear" = "unclear";

  // More comprehensive experience detection
  const experiencePatterns = [
    /\b\d+(?:\.\d+)?\s*(?:\+?\s*years?|yrs?)\b/i, // "7.5 years", "2+ years"
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

  /* ---------- 3. Category ---------- */
  let category = "unclear";

  // First, check if the job title itself contains category keywords
  const jobTitleLower = jobTitle.toLowerCase();

  // Prioritize category detection to avoid misclassification
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

  // Check job title first for category keywords
  for (const [cat, keywords] of Object.entries(categoryKeywords)) {
    if (keywords.some((k) => jobTitleLower.includes(k))) {
      category = cat;
      break;
    }
  }

  // If category is still unclear, check the full text
  if (category === "unclear") {
    for (const [cat, keywords] of Object.entries(categoryKeywords)) {
      if (keywords.some((k) => text.includes(k))) {
        category = cat;
        break;
      }
    }
  }

  /* ---------- 4. Return ---------- */
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
  interviewTime: string;
  location: string;
  agreement: string;
  education?: string;
  contact?: string;
  linkedIn?: string;
  facebook?: string;
  callTime?: string;
  resume?: string;
  lastAppraisal?: string;
  switchingReason?: string;
  totalWorkExp?: string;
  currLoc?: string;
  github?: string;
  stackOverflow?: string;
}

type DetailedParseResult = DetailedCandidateInfo | null;

export function extractDetailedCandidateInfo(
  subject: string,
  body: string
): DetailedParseResult {
  // Normalize text by replacing newlines, extra spaces, and special bullets
  const text = (subject + " " + body)
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[•*\-·]/g, "•") // Normalize all bullet characters to •
    .trim()
    .toLowerCase();

  // Helper function to extract field value
  const extractField = (pattern: RegExp): string => {
    const match = text.match(pattern);
    return match && match[1] ? match[1].trim() : "N/A";
  };

  /* ---------- 1. Position extraction ---------- */
  let position: string = "N/A";
  if (subject) {
    // Subject-specific patterns (updated to handle "Re:" prefix)
    const subjectPatterns = [
      /^(?:Re:\s*)?Application for (.+?)(?:\s*\(|\s+Role|\s+Position|$)/i,
      /^(?:Re:\s*)?New application received for the position of (.+?)(?:\s+at\s+)/i,
      /^(?:Re:\s*)?Job Opening: (.+?)(?:\s*\[|\s+at|$)/i,
      /^(?:Re:\s*)?Applying for the (.+?)(?:\s+Role|\s+Position|$)/i,
      /^(?:Re:\s*)?I'm interested in (.+?)(?:\s+Role|\s+Position|$)/i,
      /^(?:Re:\s*)?Applying for the post of (.+)$/i,
      /^(?:Re:\s*)?Application for (.+)$/i,
    ];

    for (const pattern of subjectPatterns) {
      const match = subject.match(pattern);
      if (match) {
        position = match[1].trim();
        break;
      }
    }

    // Clean up common prefixes and suffixes
    if (position !== "N/A") {
      position = position
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

  // If subject didn't yield a position, try body
  if (position === "N/A" && body) {
    position = extractField(/•\s*position\s+applied\s+for:\s*([^•]+)/i);
  }

  /* ---------- 2. Current CTC extraction ---------- */
  const currentCTC = extractField(/•\s*current\s+ctc[^:]*:\s*([^•]+)/i);

  /* ---------- 3. Expected CTC extraction ---------- */
  const expectedCTC = extractField(/•\s*expected\s+ctc:\s*([^•]+)/i);

  /* ---------- 4. Work Experience extraction ---------- */
  const workExp = extractField(
    /•\s*total\s+relevant\s+work\s+experience:\s*([^•]+)/i
  );

  /* ---------- 5. Interview Time extraction ---------- */
  const interviewTime = extractField(
    /•\s*probable\s+date\s*&\s+time\s+for\s+personal\s+interview:\s*([^•]+)/i
  );

  /* ---------- 6. Location extraction ---------- */
  const location = extractField(/•\s*current\s+location:\s*([^•]+)/i);

  /* ---------- 7. Agreement extraction ---------- */
  const agreement = extractField(
    /•\s*whether\s+ready\s+to\s+sign[^:]*:\s*([^•]+)/i
  );

  /* ---------- 8. Other fields extraction ---------- */
  const education = extractField(
    /•\s*highest\s+education\s+qualification:\s*([^•]+)/i
  );
  const contact = extractField(/•\s*verified\s+contact\s+number:\s*([^•]+)/i);
  const linkedIn = extractField(/•\s*linkedin\s+profile:\s*([^•]+)/i);
  const facebook = extractField(/•\s*facebook\s+profile:\s*([^•]+)/i);
  const callTime = extractField(/•\s*best\s+time\s+to\s+call:\s*([^•]+)/i);
  const resume = text.includes("resume")
    ? "Attached"
    : extractField(/•\s*resume:\s*([^•]+)/i);
  const lastAppraisal = extractField(/•\s*last\s+appraisal[^:]*:\s*([^•]+)/i);
  const switchingReason = extractField(
    /•\s*the\s+reason\s+for\s+switching[^:]*:\s*([^•]+)/i
  );
  const github = extractField(/•\s*github\s+repository:\s*([^•]+)/i);
  const stackOverflow = extractField(/•\s*stackoverflow\s+profile:\s*([^•]+)/i);

  // Create result object
  const result: DetailedCandidateInfo = {
    position,
    currentCTC,
    expectedCTC,
    workExp,
    interviewTime,
    location,
    agreement,
    education,
    contact,
    linkedIn,
    facebook,
    callTime,
    resume,
    lastAppraisal,
    switchingReason,
    github,
    stackOverflow,
  };

  // Set duplicate fields
  if (workExp !== "N/A") result.totalWorkExp = workExp;
  if (location !== "N/A") result.currLoc = location;

  return result;
}
