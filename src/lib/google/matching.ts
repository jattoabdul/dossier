import { ApplicationStatus } from "@/generated/prisma/enums";
import { emailAddresses } from "@/lib/application-email";
import { isInProgress } from "@/lib/status";

import { domainOf, FREEMAIL } from "./mime";

// Which application a mail is about (E15-3), from what's in the mail and the
// applications. Pure, so it's tested without Gmail. In order: the Gmail
// thread an application was sent in; the company's own mail domain, as the
// posting or the email's recipient gives it; then the company's name in the
// sender or subject, for mail from applicant tracking systems.

export type MatchableApplication = {
  id: string;
  company: string;
  status: ApplicationStatus;
  postingText: string;
  /** The application email's recipient line. */
  emailTo: string;
  updatedAt: Date;
};

export type MatchableMail = {
  threadId: string;
  fromName: string;
  fromAddress: string;
  subject: string;
};

export type MailMatch = { applicationId: string; by: "thread" | "domain" | "company" } | { applicationId: null; by: "ambiguous" } | null;

/** "jobs.northwind.example" → "northwind.example": the part a company owns. */
export function baseDomain(domain: string): string {
  const parts = domain.toLowerCase().split(".").filter(Boolean);
  // co.uk, com.au and the like keep three labels.
  const keep = parts.length >= 3 && /^(co|com|org|net|ac|gov)$/.test(parts[parts.length - 2]) ? 3 : 2;
  return parts.slice(-keep).join(".");
}

/** The company domains an application gives: from the posting's and the email's addresses, without free mail. */
export function companyDomains(application: Pick<MatchableApplication, "postingText" | "emailTo">): Set<string> {
  const domains = [...emailAddresses(application.postingText), ...emailAddresses(application.emailTo)]
    .map((address) => baseDomain(domainOf(address)))
    .filter((domain) => domain && !FREEMAIL.has(domain));
  return new Set(domains);
}

/** A company name as a word to look for: lowercase, without legal forms. */
export function companyKey(company: string): string {
  return company
    .toLowerCase()
    .replace(/\b(gmbh|ag|se|inc|ltd|llc|bv|b\.v\.|plc|co|corp|corporation|limited|group|the)\b\.?/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

/** Automated account notices and vacancy digests are not application replies. */
export function isApplicationNoise(mail: Pick<MatchableMail, "fromAddress" | "subject">): boolean {
  return /^(jobalerts-noreply|jobs-noreply)@linkedin\.com$/i.test(mail.fromAddress)
    || /personal access tokens|sign-in from (?:a )?new location|candidate portal access code|verification code|one-time (?:code|password)/i.test(mail.subject);
}

function containsCompany(value: string, key: string): boolean {
  const words = value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.some((_, start) => words.slice(start, start + 6).some((_, end) => words.slice(start, start + end + 1).join("") === key));
}

export function matchMail(
  mail: MatchableMail,
  applications: readonly MatchableApplication[],
  /** Gmail thread → application, from mail already linked. */
  threads: ReadonlyMap<string, string>,
): MailMatch {
  if (isApplicationNoise(mail)) return null;
  const byThread = threads.get(mail.threadId);
  if (byThread && applications.some((application) => application.id === byThread)) return { applicationId: byThread, by: "thread" };

  const domain = baseDomain(domainOf(mail.fromAddress));
  if (domain && !FREEMAIL.has(domain)) {
    const byDomain = applications.filter((application) => companyDomains(application).has(domain));
    // Recency and stage cannot identify the role, including at a shared agency.
    if (byDomain.length > 1) return { applicationId: null, by: "ambiguous" };
    if (byDomain.length === 1) {
      const candidate = byDomain[0];
      const key = companyKey(candidate.company);
      if (key && applications.some((application) => application.id !== candidate.id && companyKey(application.company) === key)) return { applicationId: null, by: "ambiguous" };
      return { applicationId: candidate.id, by: "domain" };
    }
  }

  // Include drafts when detecting ambiguity: an unreconciled draft may have
  // been submitted outside Dossier. A sole draft still cannot claim a reply.
  const recruitingSubject = /thank you for your interest|\b(apply|applying|application|interview|opportunity|candidate|candidacy|recruit\w*|engineer\w*|role|position|hiring|offer)\b/i.test(mail.subject);
  const byCompany = applications.filter((application) => {
    const key = companyKey(application.company);
    return key.length >= 4 && (containsCompany(mail.fromName, key) || containsCompany(domain, key) || (recruitingSubject && containsCompany(mail.subject, key)));
  });
  if (byCompany.length === 1 && byCompany[0].status !== ApplicationStatus.DRAFT) {
    return { applicationId: byCompany[0].id, by: "company" };
  }
  if (byCompany.length > 1) return { applicationId: null, by: "ambiguous" };
  return null;
}

/** Narrow a first lookup to company names and recorded recruiting domains.
 * Values are quoted data, never Gmail operators. Matching still runs locally.
 * Existing threads use the broader lookup so renamed senders remain visible.
 */
export function initialInboxQuery(applications: readonly MatchableApplication[], days = 21): string | null {
  const terms = new Set<string>();
  const quote = (value: string) => `"${value.replace(/["\\\r\n{}]/g, " ").trim()}"`;
  for (const application of applications) {
    if (application.status !== ApplicationStatus.DRAFT && companyKey(application.company).length >= 4) {
      terms.add(`from:${quote(application.company)}`);
      terms.add(`subject:${quote(application.company)}`);
    }
    for (const domain of companyDomains(application)) terms.add(`from:${quote(domain)}`);
  }
  if (!terms.size) return null;
  return `newer_than:${days}d -in:chats -category:promotions -category:social {${[...terms].join(" ")}}`;
}

const RANK: Record<ApplicationStatus, number> = {
  DRAFT: 0,
  SENT: 1,
  SCREENING: 2,
  INTERVIEW: 3,
  OFFER: 4,
  ACCEPTED: 5,
  REJECTED: 5,
  DECLINED: 5,
};

/**
 * Whether a reply's status is worth suggesting: it moves the application
 * forward, or a rejection closes one still in progress. Never backwards.
 */
export function worthSuggesting(current: ApplicationStatus, suggested: ApplicationStatus | null): boolean {
  if (!suggested || suggested === current) return false;
  if (suggested === ApplicationStatus.REJECTED) return isInProgress(current);
  return isInProgress(current) && RANK[suggested] > RANK[current];
}
