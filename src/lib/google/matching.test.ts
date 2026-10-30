import { describe, expect, it } from "vitest";

import { initialInboxQuery, baseDomain, companyDomains, companyKey, matchMail, worthSuggesting, type MatchableApplication } from "./matching";

const app = (extra: Partial<MatchableApplication> & { id: string }): MatchableApplication => ({
  company: "",
  status: "SENT",
  postingText: "",
  emailTo: "",
  updatedAt: new Date("2026-10-10"),
  ...extra,
});

const northwind = app({ id: "nw", company: "Northwind Logistics GmbH", postingText: "Send your application to careers@jobs.northwind.example." });
const ledgerly = app({ id: "lg", company: "Ledgerly", emailTo: "John Doe <john@ledgerly.example>", status: "SCREENING" });
const draft = app({ id: "draft", company: "Contoso", status: "DRAFT" });
const all = [northwind, ledgerly, draft];
const mail = (extra: Partial<Parameters<typeof matchMail>[0]>) => ({ threadId: "t-new", fromName: "", fromAddress: "", subject: "", ...extra });

describe("matchMail", () => {
  it("matches a thread Dossier sent first", () => {
    expect(matchMail(mail({ threadId: "t1", fromAddress: "someone@gmail.com" }), all, new Map([["t1", "lg"]]))).toEqual({ applicationId: "lg", by: "thread" });
  });

  it("matches the company's mail domain, subdomains included", () => {
    expect(matchMail(mail({ fromAddress: "a.keller@northwind.example" }), all, new Map())).toEqual({ applicationId: "nw", by: "domain" });
    expect(matchMail(mail({ fromAddress: "john@ledgerly.example" }), all, new Map())).toEqual({ applicationId: "lg", by: "domain" });
  });

  it("matches the company's name for applicant tracking systems", () => {
    expect(matchMail(mail({ fromName: "Ledgerly Recruiting", fromAddress: "no-reply@greenhouse.io" }), all, new Map())).toEqual({ applicationId: "lg", by: "company" });
  });

  it("doesn't match free mail, drafts or unknown companies", () => {
    expect(matchMail(mail({ fromAddress: "friend@gmail.com", subject: "Lunch?" }), all, new Map())).toBeNull();
    expect(matchMail(mail({ fromName: "Contoso Talent", fromAddress: "x@ats.example" }), all, new Map())).toBeNull();
    expect(matchMail(mail({ fromAddress: "hr@fabrikam.example" }), all, new Map())).toBeNull();
  });

  it("leaves multiple roles at the same employer unassigned without a known thread", () => {
    const older = app({ id: "old", company: "Ledgerly", emailTo: "jobs@ledgerly.example", status: "REJECTED", updatedAt: new Date("2026-10-15") });
    expect(matchMail(mail({ fromAddress: "hr@ledgerly.example" }), [older, ledgerly], new Map())).toEqual({ applicationId: null, by: "ambiguous" });
    expect(matchMail(mail({ fromName: "Ledgerly Recruiting", subject: "Application update" }), [older, ledgerly], new Map())).toEqual({ applicationId: null, by: "ambiguous" });
    expect(matchMail(mail({ threadId: "known" }), [older, ledgerly], new Map([["known", "old"]]))).toEqual({ applicationId: "old", by: "thread" });
  });

  it("does not assume an employer decision belongs to the only non-draft role", () => {
    const otherRole = app({ id: "other-role", company: "Ledgerly", status: "DRAFT" });
    expect(matchMail(mail({ fromName: "Ledgerly Recruiting", subject: "Application update" }), [ledgerly, otherRole], new Map())).toEqual({ applicationId: null, by: "ambiguous" });
    expect(matchMail(mail({ fromAddress: "john@ledgerly.example" }), [ledgerly, otherRole], new Map())).toEqual({ applicationId: null, by: "ambiguous" });
  });

  it("does not fall through an ambiguous agency domain to a company guess", () => {
    const otherClient = app({ id: "other", company: "Northwind", emailTo: "recruiter@ledgerly.example" });
    expect(matchMail(mail({ fromAddress: "john@ledgerly.example", subject: "Ledgerly application" }), [ledgerly, otherClient], new Map())).toEqual({ applicationId: null, by: "ambiguous" });
  });
});

describe("domains and names", () => {
  it("finds the part of a domain a company owns", () => {
    expect(baseDomain("jobs.northwind.example")).toBe("northwind.example");
    expect(baseDomain("mail.acme.co.uk")).toBe("acme.co.uk");
    expect([...companyDomains({ postingText: "Write to a@gmail.com or b@careers.acme.example", emailTo: "" })]).toEqual(["acme.example"]);
  });

  it("drops legal forms from company names", () => {
    expect(companyKey("Northwind Logistics GmbH")).toBe("northwindlogistics");
    expect(companyKey("The Acme Co.")).toBe("acme");
  });
});

describe("worthSuggesting", () => {
  it("moves forward, or closes with a rejection, never back", () => {
    expect(worthSuggesting("SENT", "INTERVIEW")).toBe(true);
    expect(worthSuggesting("INTERVIEW", "SCREENING")).toBe(false);
    expect(worthSuggesting("SCREENING", "REJECTED")).toBe(true);
    expect(worthSuggesting("REJECTED", "INTERVIEW")).toBe(false);
    expect(worthSuggesting("SENT", null)).toBe(false);
    expect(worthSuggesting("OFFER", "OFFER")).toBe(false);
  });
});


describe("initial inbox lookup", () => {
  it("limits lookup to recorded domains and active company headers", () => {
    expect(initialInboxQuery([ledgerly, draft], 60)).toBe('newer_than:60d -in:chats -category:promotions -category:social {from:"Ledgerly" subject:"Ledgerly" from:"ledgerly.example"}');
    expect(initialInboxQuery([])).toBeNull();
    expect(initialInboxQuery([draft])).toBeNull();
  });

  it("quotes imported company text so it cannot inject search operators", () => {
    const query = initialInboxQuery([app({ id: "unsafe", company: 'Acme"} OR in:anywhere {"' })]);
    expect(query).toBe('newer_than:21d -in:chats -category:promotions -category:social {from:"Acme   OR in:anywhere" subject:"Acme   OR in:anywhere"}');
  });
});


it("does not link job alerts, account security mail, or ordinary uses of a company word", () => {
  const signal = app({ id: "signal", company: "Signal" });
  const northstar = app({ id: "northstar", company: "Northstar" });
  for (const example of [
    { fromName: "Example Newsletter", fromAddress: "newsletter@substack.com", subject: "Robotics Tipping Signal" },
    { fromName: "Glassdoor Community", fromAddress: "noreply@glassdoor.com", subject: "I am at my breaking signal" },
    { fromName: "LinkedIn Job Alerts", fromAddress: "jobalerts-noreply@linkedin.com", subject: "Staff Backend Engineer at Northstar" },
    { fromName: "Northstar", fromAddress: "northstar@mail.northstar.example", subject: "Your personal access tokens will expire in 7 days or less" },
    { fromName: "Northstar", fromAddress: "no-reply@interviews.modernloop.io", subject: "Northstar Candidate Portal Access Code" },
  ]) expect(matchMail(mail(example), [signal, northstar], new Map())).toBeNull();
  expect(matchMail(mail({ fromName: "Morgan Example", fromAddress: "hit-reply@linkedin.com", subject: "Staff Backend Engineer role at Northstar" }), [signal, northstar], new Map())?.applicationId).toBe("northstar");
  expect(matchMail(mail({ fromAddress: "no-reply@us.greenhouse-mail.io", subject: "Thank you for applying to Northstar" }), [signal, northstar], new Map())?.applicationId).toBe("northstar");
});


it("retains an employer decision with the conventional thank-you subject", () => {
  expect(matchMail(mail({ fromName: "Recruiter", fromAddress: "recruiter@harbor.example", subject: "Thank you for your interest in Harbor" }), [app({ id: "harbor", company: "Harbor" })], new Map())?.applicationId).toBe("harbor");
});
