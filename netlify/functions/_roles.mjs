function toRoleArray(value) {
  if (Array.isArray(value)) return value
  if (typeof value === "string") {
    return value
      .split(/[\s,]+/)
      .map((r) => r.trim())
      .filter(Boolean)
  }
  return []
}

export function getRolesFromUser(user) {
  if (!user || typeof user !== "object") return []

  const fromAppMetadata = toRoleArray(user?.app_metadata?.roles)
  const fromAuthorization = toRoleArray(user?.app_metadata?.authorization?.roles)
  // User metadata can be edited by the user; only assigned app roles grant access.
  return [...fromAppMetadata, ...fromAuthorization]
    .map((role) => String(role).toLowerCase())
    .filter(Boolean)
}

export function userIsAdmin(user) {
  return Boolean(user) && getRolesFromUser(user).includes("admin")
}
