export {
  FINGERPRINT_SALT,
  GRANT_GRACE_MS,
  HEARTBEAT_MS,
  TRANSFER_MS,
  OWNER_DEVICE_LIMIT,
  USER_DEVICE_LIMIT,
  fingerprintHash,
  createLicenseIdentity,
  signEnvelope,
  readGrant,
  accessAllowed,
  hasForbidden,
  type AccessGrant
} from "../../license-server/proof"
