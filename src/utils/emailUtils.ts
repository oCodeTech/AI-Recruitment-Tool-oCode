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
  