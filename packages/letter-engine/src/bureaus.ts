import type { Bureau } from "@sweep/parsers";

export interface BureauContact {
  key: Bureau;
  displayName: string;
  addressLine1: string;
  addressLine2: string;
}

export const BUREAU_CONTACTS: Record<Bureau, BureauContact> = {
  experian: {
    key: "experian",
    displayName: "Experian",
    addressLine1: "P.O. Box 4500",
    addressLine2: "Allen, TX 75013",
  },
  equifax: {
    key: "equifax",
    displayName: "Equifax Information Services LLC",
    addressLine1: "P.O. Box 740256",
    addressLine2: "Atlanta, GA 30374",
  },
  transunion: {
    key: "transunion",
    displayName: "TransUnion Consumer Solutions",
    addressLine1: "P.O. Box 2000",
    addressLine2: "Chester, PA 19016",
  },
};

export const BUREAU_ORDER: Bureau[] = ["experian", "equifax", "transunion"];
