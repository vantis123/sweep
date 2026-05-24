export interface DisputeReason {
  id: string;
  label: string;
  text: string;
}

export const ACCOUNT_DISPUTE_REASONS: DisputeReason[] = [
  {
    id: "not-mine",
    label: "Not my accounts — identity theft",
    text: "These accounts are not mine. I never opened them. They are the result of identity theft and must be blocked under FCRA §605B.",
  },
  {
    id: "unauthorized-inquiry",
    label: "Unauthorized inquiries",
    text: "I did not authorize these inquiries. The furnishers had no permissible purpose under 15 U.S.C. §1681b. Remove these inquiries from my file.",
  },
  {
    id: "fraudulent-account",
    label: "Accounts opened fraudulently",
    text: "These accounts were opened fraudulently using my stolen personal information. I never applied for credit with these furnishers. Block these accounts under FCRA §605B.",
  },
  {
    id: "data-breach",
    label: "Result of a data breach",
    text: "This information appears on my file as a direct result of a data breach that exposed my personal information. See the enclosed breach evidence. Block these items under FCRA §605B.",
  },
  {
    id: "block-605b",
    label: "Block under 605B",
    text: "These items are the direct result of identity theft. Pursuant to FCRA §605B, block these items from my consumer file within four business days of receipt of this letter.",
  },
  {
    id: "inaccurate-payment-history",
    label: "Inaccurate payment history",
    text: "The payment history reported on these accounts is inaccurate. I have never been late on these accounts. Reinvestigate and correct under FCRA §611.",
  },
  {
    id: "collection-never-validated",
    label: "Collections — never validated",
    text: "These collection accounts have never been validated and are the result of identity theft. The original debts are not mine. Block these accounts under FCRA §605B.",
  },
  {
    id: "chargeoff-not-mine",
    label: "Charge-offs — not my accounts",
    text: "These charge-offs are not my accounts. I never opened or owed on them. They are the result of identity theft. Block and remove under FCRA §605B.",
  },
  {
    id: "public-record-not-mine",
    label: "Public records — mistaken identity",
    text: "These public records do not pertain to me. This is a case of mistaken identity. Remove these public records from my file.",
  },
  {
    id: "duplicate-account",
    label: "Duplicate accounts",
    text: "These accounts are reported more than once on my file in error. Remove the duplicates and verify the remaining listings under FCRA §611.",
  },
];

export const PERSONAL_INFO_DISPUTE_REASONS: DisputeReason[] = [
  {
    id: "address-never-lived",
    label: "Never lived at this address",
    text: "I have never lived at this address. Remove it from my file.",
  },
  {
    id: "not-my-name",
    label: "Not my name",
    text: "This is not my name. I have never used this name. Remove it from my file.",
  },
  {
    id: "not-my-employer",
    label: "Not my employer",
    text: "This is not my employer. I have never worked for this entity. Remove it from my file.",
  },
  {
    id: "wrong-dob",
    label: "Wrong date of birth",
    text: "The date of birth on file is incorrect. Correct the date of birth on my file.",
  },
  {
    id: "wrong-phone",
    label: "Wrong phone number",
    text: "This phone number is not mine. Remove it from my file.",
  },
];

export function reasonById(id: string): DisputeReason | undefined {
  return (
    ACCOUNT_DISPUTE_REASONS.find((r) => r.id === id) ??
    PERSONAL_INFO_DISPUTE_REASONS.find((r) => r.id === id)
  );
}
