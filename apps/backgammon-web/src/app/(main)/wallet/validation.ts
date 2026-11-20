export const identityFields = [
  "firstName",
  "lastName",
  "dateOfBirth",
  "email",
  "phoneNumber",
  "country",
  "streetLine1",
  "city",
  "state",
  "postalCode",
  "documentNumber",
  "documentType",
] as const;

export type IdentityField = (typeof identityFields)[number];
export type IdentityValues = Record<IdentityField, string>;
export type IdentityErrors = Partial<Record<IdentityField, string>>;

const NAME = /^\p{L}[\p{L} .'-]{0,79}$/u;
const PHONE = /^\+[1-9]\d{7,14}$/;
const COUNTRY = /^[A-Z]{2}$/;
const POSTAL = /^[A-Z0-9](?:[A-Z0-9 -]{0,17}[A-Z0-9])?$/;
const DOCUMENT_NUMBER = /^[A-Za-z0-9](?:[A-Za-z0-9 -]{0,78}[A-Za-z0-9])?$/;
const DOCUMENT_TYPES: Record<string, true> = { drivers_license: true, passport: true };

function compact(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function canonicalDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

function canonicalEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(email)) return null;
  return email;
}

export function canonicalIdentity(values: IdentityValues): IdentityValues {
  return {
    firstName: compact(values.firstName),
    lastName: compact(values.lastName),
    dateOfBirth: values.dateOfBirth.trim(),
    email: values.email.trim().toLowerCase(),
    phoneNumber: values.phoneNumber.trim(),
    country: values.country.trim().toUpperCase(),
    streetLine1: compact(values.streetLine1),
    city: compact(values.city),
    state: compact(values.state),
    postalCode: values.postalCode.trim().toUpperCase().replace(/\s+/g, " "),
    documentNumber: values.documentNumber.trim(),
    documentType: values.documentType.trim(),
  };
}

export function validateIdentity(values: IdentityValues, fields: readonly IdentityField[] = identityFields): IdentityErrors {
  const normalized = canonicalIdentity(values);
  const errors: IdentityErrors = {};
  const requireField = (field: IdentityField, valid: boolean, message: string) => {
    if (fields.includes(field) && !valid) errors[field] = message;
  };

  requireField("firstName", NAME.test(normalized.firstName), "Enter a valid first name.");
  requireField("lastName", NAME.test(normalized.lastName), "Enter a valid last name.");
  requireField("dateOfBirth", canonicalDate(normalized.dateOfBirth) !== null, "Enter a real date in YYYY-MM-DD format.");
  requireField("email", canonicalEmail(normalized.email) !== null, "Enter a valid email address.");
  requireField("phoneNumber", PHONE.test(normalized.phoneNumber), "Enter a phone number in international +123456789 format.");
  requireField("country", COUNTRY.test(normalized.country), "Use a two-letter ISO country code.");
  requireField("streetLine1", normalized.streetLine1.length > 0 && normalized.streetLine1.length <= 120, "Enter a street address.");
  requireField("city", normalized.city.length > 0 && normalized.city.length <= 100, "Enter a city.");
  requireField("state", normalized.state.length > 0 && normalized.state.length <= 100, "Enter a state or region.");
  requireField("postalCode", POSTAL.test(normalized.postalCode), "Enter a valid postal code.");
  requireField("documentNumber", DOCUMENT_NUMBER.test(normalized.documentNumber), "Enter a valid identity document number.");
  requireField("documentType", Boolean(DOCUMENT_TYPES[normalized.documentType]), "Choose a supported identity document type.");
  return errors;
}

export function firstIdentityError(errors: IdentityErrors, fields: readonly IdentityField[]): IdentityField | null {
  return fields.find((field) => errors[field]) ?? null;
}
