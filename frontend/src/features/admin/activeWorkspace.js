/**
 * Resolves the customer workspace the console is actually showing.
 *
 * Falling back to the first row when the active id was not in the list — which
 * a superadmin hits whenever the stored active organization has been renamed,
 * suspended or removed — put another customer's name in the topbar and another
 * customer's account contact, billing email and extension range in the
 * editors, so an operator saved edits against a customer they never opened.
 * There is no safe default here: when the active workspace is not in the list,
 * the caller has to say so rather than show a neighbour.
 */
export function findActiveWorkspace(organizations, activeOrganizationId) {
  const list = Array.isArray(organizations) ? organizations : [];
  const index = activeOrganizationId ? list.findIndex((item) => item?.id === activeOrganizationId) : -1;
  return { index, organization: index === -1 ? null : list[index] };
}
